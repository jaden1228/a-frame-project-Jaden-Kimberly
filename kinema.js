/**
 * Kinema body.
 *
 * Based on kinematic-body, from AFrame Extras (for now, basically a copy,
 *   just because I read it is deprecated in AFrame Extras)
 *
 *   https://github.com/donmccurdy/aframe-extras/blob/master/src/misc/kinematic-body.js
 *
 * Managed dynamic body, which moves but is not affected (directly) by the
 * physics engine. This is not a true kinematic body, in the sense that we are
 * letting the physics engine _compute_ collisions against it and selectively
 * applying those collisions to the object. The physics engine does not decide
 * the position/velocity/rotation of the element.
 *
 * Used for the camera object, because full physics simulation would create
 * movement that feels unnatural to the player. Bipedal movement does not
 * translate nicely to rigid body physics.
 *
 * See: http://www.learn-cocos2d.com/2013/08/physics-engine-platformer-terrible-idea/
 * And: http://oxleygamedev.blogspot.com/2011/04/player-physics-part-2.html
 */
const EPS = 0.000001;

AFRAME.registerComponent('kinema-body', {
  dependencies: ['velocity'],

  /*******************************************************************
   * Schema
   */

  schema: {
    mass:           { default: 5 },
    radius:         { default: 1.3 },
    linearDamping:  { default: 0.05 },
    enableSlopes:   { default: true },
    enableJumps:    { default: false },
  },

  /*******************************************************************
   * Lifecycle
   */

  init: function () {
    this.system = this.el.sceneEl.systems.physics;
    this.system.addComponent(this);

    const el = this.el,
        data = this.data,
        position = (new CANNON.Vec3()).copy(el.object3D.getWorldPosition(new THREE.Vector3()));

    this.body = new CANNON.Body({
      material: this.system.getMaterial('staticMaterial'),
      position: position,
      mass: data.mass,
      linearDamping: data.linearDamping,
      fixedRotation: true
    });
    this.body.addShape(
      new CANNON.Sphere(data.radius),
      new CANNON.Vec3(0, data.radius, 0)
    );

    this.body.el = this.el;
    this.el.body = this.body;
    this.system.addBody(this.body);

    if (el.hasAttribute('wasd-controls')) {
      console.warn('[kinema-body] Not compatible with wasd-controls, use movement-controls.');
    }
  },

  remove: function () {
    this.system.removeBody(this.body);
    this.system.removeComponent(this);
    delete this.el.body;
  },

  /*******************************************************************
   * Update
   */

  /**
   * Checks CANNON.World for collisions and attempts to apply them to the
   * element automatically, in a player-friendly way.
   *
   * There's extra logic for horizontal surfaces here. The basic requirements:
   * (1) Only apply gravity when not in contact with _any_ horizontal surface.
   * (2) When moving, project the velocity against exactly one ground surface.
   *     If in contact with two ground surfaces (e.g. ground + ramp), choose
   *     the one that collides with current velocity, if any.
   */
  beforeStep: function (t, dt) {
    if (!dt) return;

    const el = this.el;
    const data = this.data
    const body = this.body;

    if (!data.enableJumps) body.velocity.set(0, 0, 0);
    body.position.copy(el.getAttribute('position'));
  },

  step: (function () {
    const velocity = new THREE.Vector3(),
        normalizedVelocity = new THREE.Vector3(),
        currentSurfaceNormal = new THREE.Vector3(),
        groundNormal = new THREE.Vector3();

    return function (t, dt) {
      if (!dt) return;

      let body = this.body,
          data = this.data,
          didCollide = false,
          height, groundHeight = -Infinity,
          groundBody,
          contacts = this.system.getContacts();

      dt = Math.min(dt, this.system.data.maxInterval * 1000);

      groundNormal.set(0, 0, 0);
      velocity.copy(this.el.getAttribute('velocity'));
      body.velocity.copy(velocity);

      for (var i = 0, contact; contact = contacts[i]; i++) {
        // 1. Find any collisions involving this element. Get the contact
        // normal, and make sure it's oriented _out_ of the other object and
        // enabled (body.collisionReponse is true for both bodies)
        if (!contact.enabled) { continue; }
        if (body.id === contact.bi.id) {
          contact.ni.negate(currentSurfaceNormal);
        } else if (body.id === contact.bj.id) {
          currentSurfaceNormal.copy(contact.ni);
        } else {
          continue;
        }

        didCollide = body.velocity.dot(currentSurfaceNormal) < -EPS;
        if (didCollide && currentSurfaceNormal.y <= 0.5) {
          // 2. If current trajectory attempts to move _through_ another
          // object, project the velocity against the collision plane to
          // prevent passing through.
          velocity.projectOnPlane(currentSurfaceNormal);
        } else if (currentSurfaceNormal.y > 0.5) {
          // 3. If in contact with something roughly horizontal (+/- 45º) then
          // consider that the current ground. Only the highest qualifying
          // ground is retained.
          height = body.id === contact.bi.id
            ? Math.abs(contact.rj.y + contact.bj.position.y)
            : Math.abs(contact.ri.y + contact.bi.position.y);
          if (height > groundHeight) {
            groundHeight = height;
            groundNormal.copy(currentSurfaceNormal);
            groundBody = body.id === contact.bi.id ? contact.bj : contact.bi;
          }
        }
      }

      normalizedVelocity.copy(velocity).normalize();
      if (groundBody && (!data.enableJumps || normalizedVelocity.y < 0.5)) {
        if (!data.enableSlopes) {
          groundNormal.set(0, 1, 0);
        } else if (groundNormal.y < 1 - EPS) {
          groundNormal.copy(this.raycastToGround(groundBody, groundNormal));
        }

        // 4. Project trajectory onto the top-most ground object, unless
        // trajectory is > 45º.
        velocity.projectOnPlane(groundNormal);

      } else if (this.system.driver.world) {
        // 5. If not in contact with anything horizontal, apply world gravity.
        // TODO - Why is the 4x scalar necessary.
        // NOTE: Does not work if physics runs on a worker.
        //In below calculation, 100 was 1000.  Allows the camera to drop faster
        velocity.add(this.system.driver.world.gravity.scale(dt * 4.0 / 50));
      }

      body.velocity.copy(velocity);
      this.el.setAttribute('velocity', body.velocity);
      this.el.setAttribute('position', body.position);
    };
  }()),

  /**
   * When walking on complex surfaces (trimeshes, borders between two shapes),
   * the collision normals returned for the player sphere can be very
   * inconsistent. To address this, raycast straight down, find the collision
   * normal, and return whichever normal is more vertical.
   * @param  {CANNON.Body} groundBody
   * @param  {CANNON.Vec3} groundNormal
   * @return {CANNON.Vec3}
   */
  raycastToGround: function (groundBody, groundNormal) {
    let ray,
        hitNormal,
        vFrom = this.body.position,
        vTo = this.body.position.clone();

    ray = new CANNON.Ray(vFrom, vTo);
    //ray._updateDirection(); // TODO - Report bug.
    ray.intersectBody(groundBody);

    if (!ray.hasHit) return groundNormal;

    // Compare ABS, in case we're projecting against the inside of the face.
    hitNormal = ray.result.hitNormalWorld;
    return Math.abs(hitNormal.y) > Math.abs(groundNormal.y) ? hitNormal : groundNormal;
  }
});