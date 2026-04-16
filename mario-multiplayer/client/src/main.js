import Phaser from 'phaser';
import { io } from 'socket.io-client';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'app',
  pixelArt: true,
  roundPixels: true,
  antialias: false,
  backgroundColor: '#5c94fc',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 2200 },
      debug: false,
      fixedStep: true,
      tileBias: 64
    }
  },
  scene: { preload, create, update },
  fps: {
    target: 60,
    forceSetTimeOut: true
  },
  pauseOnBlur: false
};

const WALK_MAX_VELOCITY = 350;
const RUN_MAX_VELOCITY = 700;
const ACCEL = 600;
const DRAG = 600;
const SKID_DRAG = 1200;
const JUMP_FORCE = -1100;
const VARIABLE_JUMP_MODIFIER = 0.5;

const game = new Phaser.Game(config);
let socket;
let player;
let cursors;
let otherPlayers;
let layer;
let playerCollider;
let moveHoldTimer = 0;
let keyX;
let fireballs;
let enemies;
let fireTrails = {}; // { [fireballId]: emitter }
let shootTimer = 0;

function preload() {
  this.load.spritesheet('tiles', '/tileset.png', { frameWidth: 64, frameHeight: 64 });
  this.load.atlas('mario', '/mario_sprite.png', '/mario.json');
}

function create() {
  console.log('Phaser Create started');
  socket = io('http://localhost:3000');

  otherPlayers = this.physics.add.group();

  setupAnimations(this);

  socket.on('initMap', (mapData) => {
    console.log('Received map data');
    
    // Clear game state on map reset
    if (layer) {
      layer.destroy();
      layer = null;
    }
    if (playerCollider) {
      this.physics.world.removeCollider(playerCollider);
      playerCollider = null;
    }
    
    // Clear all sprite groups to prevent "traces" of old objects
    if (enemies) enemies.clear(true, true);
    if (this.items) this.items.clear(true, true);
    if (otherPlayers) otherPlayers.clear(true, true);
    
    if (fireballs) {
      fireballs.clear(true, true);
      // Clean up fire trails
      Object.keys(fireTrails).forEach(id => {
        if (fireTrails[id]) fireTrails[id].destroy();
      });
      fireTrails = {};
    }

    const map = this.make.tilemap({
      data: mapData.data,
      tileWidth: 64,
      tileHeight: 64
    });
    const tileset = map.addTilesetImage('tiles', 'tiles');
    layer = map.createLayer(0, tileset, 0, 0);

    if (layer) {
      // Explicitly set collision for all solid tiles:
      layer.setCollision([1, 33, 94, 95, 110, 111, 129, 136, 145, 160]);

      const mapWidth = map.widthInPixels;
      const mapHeight = map.heightInPixels;
      this.physics.world.setBounds(0, 0, mapWidth, mapHeight + 500);
      this.cameras.main.setBounds(0, 0, mapWidth, mapHeight);
      this.cameras.main.setZoom(0.5);

      if (player) {
        player.levelFinished = false;
        playerCollider = this.physics.add.collider(player, layer, handleTileCollision, null, this);
      }
    }
  });

  socket.on('levelFinished', () => {
    if (player && player.body) {
      player.levelFinished = true;
      player.setVelocity(0, 0);
      player.setAcceleration(0, 0);
    }
  });

  socket.on('currentPlayers', (players) => {
    Object.keys(players).forEach((id) => {
      if (id === socket.id) {
        addPlayer(this, players[id]);
      } else {
        addOtherPlayers(this, players[id]);
      }
    });
  });

  socket.on('newPlayer', (playerInfo) => {
    addOtherPlayers(this, playerInfo);
  });

  socket.on('playerMoved', (playerInfo) => {
    let otherPlayer = otherPlayers.getChildren().find(p => p.id === playerInfo.id);

    // If other player sprite doesn't exist yet, create it
    if (!otherPlayer && playerInfo.id !== socket.id) {
      addOtherPlayers(this, playerInfo);
      otherPlayer = otherPlayers.getChildren().find(p => p.id === playerInfo.id);
    }

    if (otherPlayer) {
      if (otherPlayer.state !== playerInfo.state) {
        applyPlayerState(otherPlayer, playerInfo.state);
      }
      otherPlayer.targetX = playerInfo.x;
      otherPlayer.targetY = playerInfo.y;
      otherPlayer.flipX = playerInfo.flipX;
      otherPlayer.dead = playerInfo.dead;
      otherPlayer.invulnTimer = playerInfo.invulnTimer;

      if (playerInfo.dead) {
        otherPlayer.anims.play('die', true);
      } else if (playerInfo.anim) {
        otherPlayer.anims.play(playerInfo.anim, true);
      }
      otherPlayer.invincible = playerInfo.invincible;
    }

    // Handle local player state sync from server
    if (player && playerInfo.id === socket.id) {
      if (player.state !== playerInfo.state) {
        player.state = playerInfo.state;
        applyPlayerState(player, playerInfo.state);
      }
      player.invincible = playerInfo.invincible;
      player.dead = playerInfo.dead;
      player.invulnTimer = playerInfo.invulnTimer;
      
      // Force position sync if we're far away (like during a level restart)
      const distSq = Phaser.Math.Distance.Squared(player.x, player.y, playerInfo.x, playerInfo.y);
      if (distSq > 100 * 100 || player.dead) {
        player.setPosition(playerInfo.x, playerInfo.y);
        player.setVelocity(0, 0);
        player.setAcceleration(0, 0);
      }
    }
  });

  socket.on('tileUpdate', (data) => {
    const { x, y, newTile } = data;
    if (!layer) return;
    const tile = layer.getTileAt(x, y);
    if (tile) {
      bounceTile(this, tile, newTile);
    }
  });

  socket.on('playerDisconnected', (id) => {
    otherPlayers.getChildren().forEach((otherPlayer) => {
      if (id === otherPlayer.id) otherPlayer.destroy();
    });
  });

  cursors = this.input.keyboard.createCursorKeys();
  keyX = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);

  fireballs = this.add.group();
  enemies = this.add.group();
  this.items = this.physics.add.group();

  socket.on('fireballSpawned', (data) => {
    const fireballSprite = this.add.sprite(data.x, data.y, 'tiles', 241).setScale(1);
    fireballSprite.id = data.id;
    fireballSprite.lastUpdate = Date.now();
    fireballs.add(fireballSprite);

    // Create particle trail (Phaser 3.60+ syntax)
    const emitter = this.add.particles(0, 0, 'tiles', {
      frame: 241,
      speed: { min: 20, max: 50 },
      scale: { start: 0.15, end: 0 },
      blendMode: 'ADD',
      lifespan: 300,
      frequency: 20,
      follow: fireballSprite,
      tint: [0xff0000, 0xffff00, 0xffa500] // Red, Yellow, Orange
    });
    fireTrails[data.id] = emitter;
  });

  socket.on('fireballUpdates', (updates) => {
    updates.forEach(u => {
      const fb = fireballs.getChildren().find(f => f.id === u.id);
      if (fb) {
        fb.x = u.x;
        fb.y = u.y;
        fb.angle += 15; // Spinning effect
        fb.lastUpdate = Date.now();
      }
    });
  });

  socket.on('fireballDestroyed', (id) => {
    const fb = fireballs.getChildren().find(f => f.id === id);
    if (fb) {
      // Explosion effect (Phaser 3.60+ syntax)
      const explosion = this.add.particles(fb.x, fb.y, 'tiles', {
        frame: 241,
        speed: { min: 50, max: 150 },
        scale: { start: 0.25, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: 400,
        gravityY: 200,
        blendMode: 'ADD',
        tint: [0xff4500, 0xffd700],
        maxParticles: 10,
        emitting: false
      });
      explosion.explode(10);

      // Cleanup explosion emitter after particles are gone
      this.time.delayedCall(500, () => explosion.destroy());

      fb.destroy();
    }
    if (fireTrails[id]) {
      const emitter = fireTrails[id];
      emitter.stop();
      // Cleanup emitter object after lifespan
      this.time.delayedCall(300, () => emitter.destroy());
      delete fireTrails[id];
    }
  });

  socket.on('playerKnockback', (force) => {
    if (player && player.body) {
      player.setVelocity(force.vx, force.vy);
      player.setTint(0xff0000); // Visual indicator of hit
      this.time.delayedCall(200, () => player.clearTint());
    }
  });

  socket.on('initItems', (items) => {
    this.items.clear(true, true);
    Object.keys(items).forEach(id => {
      createItemSprite(this, items[id]);
    });
  });

  socket.on('itemSpawned', (item) => {
    createItemSprite(this, item);
  });

  socket.on('itemUpdates', (updates) => {
    updates.forEach(update => {
      const itemSprite = this.items.getChildren().find(i => i.id === update.id);
      if (itemSprite) {
        itemSprite.x = update.x;
        itemSprite.y = update.y;
      }
    });
  });

  socket.on('itemDestroyed', (data) => {
    const itemSprite = this.items.getChildren().find(i => i.id === data.itemId);
    if (itemSprite) {
      itemSprite.destroy();
    }

    // If local player collected it, update state
    if (data.collectorId === socket.id && player) {
      player.state = data.newState;
      applyPlayerState(player, data.newState);
      if (data.invincible !== undefined) player.invincible = data.invincible;
    }
  });

  socket.on('playerBounce', () => {
    if (player && player.body) {
      player.setVelocityY(-1000); // Bounce the player up
    }
  });

  socket.on('initEnemies', (data) => {
    enemies.clear(true, true);
    Object.keys(data).forEach(id => {
      createEnemySprite(this, data[id]);
    });
  });

  socket.on('enemySpawned', (enemy) => {
    createEnemySprite(this, enemy);
  });

  socket.on('enemyUpdates', (updates) => {
    updates.forEach(u => {
      const e = enemies.getChildren().find(sprite => sprite.id === u.id);
      if (e) {
        e.x = u.x;
        e.y = u.y;
        e.flipX = u.vx > 0;
        if (e.anims) e.anims.play('goomba_walk', true);
      }
    });
  });

  socket.on('enemyDestroyed', (data) => {
    const e = enemies.getChildren().find(sprite => sprite.id === data.id);
    if (e) {
      if (data.reason === 'stomped') {
        e.anims.play('goomba_flat');
        this.time.delayedCall(200, () => e.destroy());
      } else {
        // Fireball or other: Flip away
        e.setTint(0xff0000);
        this.tweens.add({
          targets: e,
          y: e.y - 100,
          angle: 180,
          alpha: 0,
          duration: 400,
          onComplete: () => e.destroy()
        });
      }
    }
  });

  //this.add.text(10, 10, 'Use Arrows to move.', { fill: '#ffffff' }).setScrollFactor(0);
}

function createItemSprite(scene, item) {
  let frame = 238; // Default Mushroom
  if (item.type === 'fire_flower') frame = 244;
  if (item.type === 'star') frame = 243;
  if (item.type === 'coin') frame = 226;

  const sprite = scene.items.create(item.x, item.y, 'tiles', frame);
  sprite.id = item.id;
  sprite.body.setAllowGravity(false); // Server handles gravity

  if (item.type === 'coin') {
    // Pop up animation for coin
    scene.tweens.add({
      targets: sprite,
      y: item.y - 128,
      alpha: 0,
      duration: 300,
      onComplete: () => sprite.destroy()
    });
  } else if (player) {
    scene.physics.add.overlap(player, sprite, () => {
      socket.emit('collectItem', item.id);
    });
  }
}

function createEnemySprite(scene, enemy) {
  let frame = 200; // Goomba
  const sprite = scene.add.sprite(enemy.x, enemy.y, 'tiles', frame).setScale(1);
  sprite.id = enemy.id;
  sprite.type = enemy.type;
  enemies.add(sprite);
}

function handleTileCollision(obj1, tile) {
  if (player && player.body && player.body.blocked.up) {
    socket.emit('blockHit', { x: tile.x, y: tile.y });
  }
}

function bounceTile(scene, tile, newTileIndex) {
  const x = tile.x;
  const y = tile.y;
  const tileWorldX = tile.pixelX + tile.width / 2;
  const tileWorldY = tile.pixelY + tile.height / 2;

  // tile.index is now 0-based index matching spritesheet frames
  const bounceSprite = scene.add.sprite(tileWorldX, tileWorldY, 'tiles', tile.index);
  bounceSprite.setOrigin(0.5);

  layer.removeTileAt(x, y);

  scene.tweens.add({
    targets: bounceSprite,
    y: tileWorldY - 20,
    duration: 100,
    yoyo: true,
    ease: 'Power1',
    onComplete: () => {
      bounceSprite.destroy();
      const newTile = layer.putTileAt(newTileIndex, x, y);
      // Ensure physics recalculates collision faces for this tile
      if (newTile) {
        newTile.setCollision(true);
      }
    }
  });
}

function setupAnimations(scene) {
  // Small Mario
  scene.anims.create({ key: 'idle', frames: [{ key: 'mario', frame: 'idle' }], frameRate: 10 });
  scene.anims.create({
    key: 'walk',
    frames: [{ key: 'mario', frame: 'run_1' }, { key: 'mario', frame: 'run_2' }, { key: 'mario', frame: 'run_3' }],
    frameRate: 12, repeat: -1
  });
  scene.anims.create({ key: 'jump', frames: [{ key: 'mario', frame: 'jump' }], frameRate: 10 });
  scene.anims.create({ key: 'skid', frames: [{ key: 'mario', frame: 'skid' }], frameRate: 10 });

  // Big Mario
  scene.anims.create({ key: 'big_idle', frames: [{ key: 'mario', frame: 'big_idle' }], frameRate: 10 });
  scene.anims.create({
    key: 'big_walk',
    frames: [{ key: 'mario', frame: 'big_run_1' }, { key: 'mario', frame: 'big_run_2' }, { key: 'mario', frame: 'big_run_3' }],
    frameRate: 12, repeat: -1
  });
  scene.anims.create({ key: 'big_jump', frames: [{ key: 'mario', frame: 'big_jump' }], frameRate: 10 });
  scene.anims.create({ key: 'big_skid', frames: [{ key: 'mario', frame: 'big_skid' }], frameRate: 10 });

  // Fire Mario
  scene.anims.create({ key: 'fire_idle', frames: [{ key: 'mario', frame: 'fire_idle' }], frameRate: 10 });
  scene.anims.create({
    key: 'fire_walk',
    frames: [{ key: 'mario', frame: 'fire_run_1' }, { key: 'mario', frame: 'fire_run_2' }, { key: 'mario', frame: 'fire_run_3' }],
    frameRate: 12, repeat: -1
  });
  scene.anims.create({ key: 'fire_jump', frames: [{ key: 'mario', frame: 'fire_jump' }], frameRate: 10 });
  scene.anims.create({ key: 'fire_skid', frames: [{ key: 'mario', frame: 'fire_skid' }], frameRate: 10 });
  scene.anims.create({ key: 'fire_shoot', frames: [{ key: 'mario', frame: 'fire_shoot' }], frameRate: 10 });

  scene.anims.create({ key: 'die', frames: [{ key: 'mario', frame: 'die' }], frameRate: 10 });

  // Goomba
  scene.anims.create({
    key: 'goomba_walk',
    frames: scene.anims.generateFrameNumbers('tiles', { start: 200, end: 201 }),
    frameRate: 6,
    repeat: -1
  });
  scene.anims.create({ key: 'goomba_flat', frames: [{ key: 'tiles', frame: 202 }], frameRate: 10 });
}

function applyPlayerState(p, state) {
  p.state = state;
  if (state === 0) {
    p.setSize(16, 16);
    p.setOffset(0, 0);
  } else {
    p.setSize(16, 32);
    p.setOffset(0, 0);
  }
}

function getAnimKey(baseKey, state) {
  if (state === 1) return 'big_' + baseKey;
  if (state === 2) return 'fire_' + baseKey;
  return baseKey;
}

function addPlayer(scene, playerInfo) {
  if (player) return;
  const x = playerInfo.x || 150;
  const y = playerInfo.y || 700;

  player = scene.physics.add.sprite(x, y, 'mario');
  player.setScale(4);
  player.setCollideWorldBounds(true);
  applyPlayerState(player, playerInfo.state || 0);

  if (layer) {
    if (playerCollider) scene.physics.world.removeCollider(playerCollider);
    playerCollider = scene.physics.add.collider(player, layer, handleTileCollision, null, scene);
  }

  player.body.setDragX(DRAG);
  player.body.setMaxVelocity(RUN_MAX_VELOCITY, 1100);
  scene.cameras.main.startFollow(player, true);
}

function addOtherPlayers(scene, playerInfo) {
  // Prevent duplicate sprites for the same player ID
  if (otherPlayers.getChildren().find(p => p.id === playerInfo.id)) return;
  
  const otherPlayer = scene.physics.add.sprite(playerInfo.x, playerInfo.y, 'mario').setScale(4);
  otherPlayer.id = playerInfo.id;
  otherPlayer.targetX = playerInfo.x;
  otherPlayer.targetY = playerInfo.y;
  otherPlayer.body.moves = false; // Prevent local physics (gravity/velocity) from interfering with server-synced position
  applyPlayerState(otherPlayer, playerInfo.state || 0);
  if (playerInfo.anim) otherPlayer.anims.play(playerInfo.anim, true);
  otherPlayer.invincible = playerInfo.invincible || false;
  otherPlayers.add(otherPlayer);
}

let lastEmitTime = 0;
const EMIT_THRESHOLD_MS = 15; // Decreased from 33ms to 15ms (~60fps) for smoother jump tracking
const MOVE_THRESHOLD = 0.1;   // Slightly more sensitive movement detection

function update(time, delta) {
  if (shootTimer > 0) shootTimer -= delta;

  otherPlayers.getChildren().forEach((otherPlayer) => {
    if (otherPlayer.targetX !== undefined && otherPlayer.targetY !== undefined) {
      const lerpFactor = 0.4; // Increased from 0.15 to make movement feel more direct and less "floaty"
      const newX = Phaser.Math.Linear(otherPlayer.x, otherPlayer.targetX, lerpFactor);
      const newY = Phaser.Math.Linear(otherPlayer.y, otherPlayer.targetY, lerpFactor);
      otherPlayer.setPosition(newX, newY);

      // Apply jump frame offsets
      const isJumping = otherPlayer.anims.currentAnim && otherPlayer.anims.currentAnim.key.includes('jump');

      if (isJumping) {
        const jumpHeight = (otherPlayer.state === 0) ? 16 : 32;
        if (otherPlayer.state === 2) {
          otherPlayer.setSize(12, 32);
          otherPlayer.setOffset(otherPlayer.flipX ? 2 : 6, 0);
        } else {
          otherPlayer.setSize(16, jumpHeight);
          otherPlayer.setOffset(otherPlayer.flipX ? 0 : 4, 0);
        }
      } else {
        if (otherPlayer.state === 0) {
          if (otherPlayer.body.height !== 16) otherPlayer.setSize(16, 16);
        } else {
          if (otherPlayer.body.height !== 32) otherPlayer.setSize(16, 32);
        }
        otherPlayer.setOffset(0, 0);
      }

      // Rainbow Effect for Other Players
      if (otherPlayer.invincible) {
        const colors = [0xff0000, 0xffa500, 0xffff00, 0x00ff00, 0x0000ff, 0x4b0082, 0xee82ee];
        const colorIndex = Math.floor(time / 50) % colors.length;
        otherPlayer.setTint(colors[colorIndex]);
      } else {
        // Clear tint unless they were just hit (handled by knockback event or similar)
        // For simplicity, we'll just clear it if not invincible, 
        // but we should be careful not to override knockback red tint too quickly.
        // Actually, the server broadcasts 'invincible: false' when it ends.
        if (otherPlayer.oldInvincible && !otherPlayer.invincible) {
          otherPlayer.clearTint();
        }
      }
      otherPlayer.oldInvincible = otherPlayer.invincible;

      // Invulnerability Flicker for Other Players
      if (!otherPlayer.invincible && otherPlayer.invulnTimer > 0) {
        otherPlayer.alpha = (Math.floor(time / 50) % 2 === 0) ? 0.5 : 1;
      } else {
        otherPlayer.alpha = 1;
      }
    }
  });

  // Safety cleanup for fireballs
  const now = Date.now();
  fireballs.getChildren().forEach((fb) => {
    if (now - fb.lastUpdate > 5000) {
      if (fireTrails[fb.id]) {
        fireTrails[fb.id].stop();
        delete fireTrails[fb.id];
      }
      fb.destroy();
    }
  });

  if (player && player.body) {
    if (player.dead || player.levelFinished) {
      if (player.dead) {
        player.anims.play('die', true);
      } else {
        const state = player.state || 0;
        player.anims.play(getAnimKey('idle', state), true);
      }
      player.setVelocity(0, 0);
      player.setAcceleration(0, 0);
      player.setCollideWorldBounds(player.levelFinished); // Keep in world if finished, fall out if dead
      return;
    }
    player.setCollideWorldBounds(true);
    player.body.setAllowGravity(true);

    const isGrounded = player.body.blocked.down || player.body.touching.down;
    const currentVelocityX = player.body.velocity.x;
    const absVelocityX = Math.abs(currentVelocityX);
    const state = player.state || 0;

    if (cursors.left.isDown) {
      if (currentVelocityX > 150) {
        player.setAccelerationX(-ACCEL * 2);
        player.body.setDragX(SKID_DRAG);
        player.anims.play(getAnimKey('skid', state), true);
      } else {
        player.setAccelerationX(-ACCEL);
        player.body.setDragX(DRAG);
        player.flipX = true;
        moveHoldTimer += delta;
        const maxSpeed = moveHoldTimer > 100 ? RUN_MAX_VELOCITY : WALK_MAX_VELOCITY;
        player.body.setMaxVelocity(maxSpeed, 1100);
        if (isGrounded) player.anims.play(getAnimKey('walk', state), true);
      }
    } else if (cursors.right.isDown) {
      if (currentVelocityX < -150) {
        player.setAccelerationX(ACCEL * 2);
        player.body.setDragX(SKID_DRAG);
        player.anims.play(getAnimKey('skid', state), true);
      } else {
        player.setAccelerationX(ACCEL);
        player.body.setDragX(DRAG);
        player.flipX = false;
        moveHoldTimer += delta;
        const maxSpeed = moveHoldTimer > 100 ? RUN_MAX_VELOCITY : WALK_MAX_VELOCITY;
        player.body.setMaxVelocity(maxSpeed, 1100);
        if (isGrounded) player.anims.play(getAnimKey('walk', state), true);
      }
    } else {
      player.setAccelerationX(0);
      player.body.setDragX(DRAG);
      moveHoldTimer = 0;
      if (isGrounded) {
        if (absVelocityX < 10) {
          if (shootTimer <= 0) player.anims.play(getAnimKey('idle', state), true);
        } else {
          if (shootTimer <= 0) player.anims.play(getAnimKey('walk', state), true);
        }
      }
    }

    if (cursors.up.isDown && isGrounded) player.setVelocityY(JUMP_FORCE);
    if (!cursors.up.isDown && player.body.velocity.y < 0) player.setVelocityY(player.body.velocity.y * VARIABLE_JUMP_MODIFIER);

    if (!isGrounded && Math.abs(player.body.velocity.y) > 20) {
      if (shootTimer <= 0) {
        player.anims.play(getAnimKey('jump', state), true);
      }

      const jumpHeight = (state === 0) ? 16 : 32;
      
      if (state === 2) {
        player.setSize(12, 32);
        player.setOffset(player.flipX ? 2 : 6, 0);
      } else {
        player.setSize(16, jumpHeight);
        player.setOffset(player.flipX ? 0 : 4, 0);
      }
    } else if (isGrounded) {
      if (state === 0) {
        if (player.body.height !== 16) player.setSize(16, 16);
      } else {
        if (player.body.height !== 32) player.setSize(16, 32);
      }
      player.setOffset(0, 0);
    }

    if (shootTimer > 0 && state === 2) {
      player.anims.play('fire_shoot', true);
      player.setOffset(0, 0);
    }

    if (Phaser.Input.Keyboard.JustDown(keyX) && player.state === 2) {
      socket.emit('shootFireball');
      shootTimer = 150;
      player.anims.play('fire_shoot', true);
    }

    const now = Date.now();
    const x = Math.round(player.x * 10) / 10;
    const y = Math.round(player.y * 10) / 10;
    const anim = player.anims.currentAnim ? player.anims.currentAnim.key : 'idle';
    const flipX = player.flipX;

    const hasMovedSignificantly = !player.oldPosition ||
      Math.abs(x - player.oldPosition.x) > MOVE_THRESHOLD ||
      Math.abs(y - player.oldPosition.y) > MOVE_THRESHOLD ||
      anim !== player.oldPosition.anim ||
      flipX !== player.oldPosition.flipX ||
      state !== player.oldPosition.state ||
      player.invincible !== player.oldPosition.invincible;

    if (hasMovedSignificantly && now - lastEmitTime > EMIT_THRESHOLD_MS) {
      socket.emit('playerMovement', { x, y, anim, flipX, state });
      lastEmitTime = now;
      player.oldPosition = { x, y, anim, flipX, state, invincible: player.invincible };
    }

    // Rainbow Effect for Local Player
    if (player.invincible) {
      const colors = [0xff0000, 0xffa500, 0xffff00, 0x00ff00, 0x0000ff, 0x4b0082, 0xee82ee];
      const colorIndex = Math.floor(time / 50) % colors.length;
      player.setTint(colors[colorIndex]);
    } else {
      if (player.oldInvincible && !player.invincible) {
        player.clearTint();
      }
    }
    player.oldInvincible = player.invincible;

    // Invulnerability Flicker for Local Player
    if (!player.invincible && player.invulnTimer > 0) {
      player.alpha = (Math.floor(time / 50) % 2 === 0) ? 0.5 : 1;
    } else {
      player.alpha = 1;
    }
  }
}
