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
let moveHoldTimer = 0;

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
    const map = this.make.tilemap({
      data: mapData.data,
      tileWidth: 64,
      tileHeight: 64
    });
    const tileset = map.addTilesetImage('tiles', 'tiles');
    layer = map.createLayer(0, tileset, 0, 0);

    if (layer) {
      // Explicitly set collision for all solid tiles:
      // 1:Brick, 129:Question, 136:HitQuestion, 94,95,110,111:Pipes, 145,160:Ground, 33:HardBlock
      layer.setCollision([1, 33, 94, 95, 110, 111, 129, 136, 145, 160]);

      const mapWidth = map.widthInPixels;
      const mapHeight = map.heightInPixels;
      this.physics.world.setBounds(0, 0, mapWidth, mapHeight);
      this.cameras.main.setBounds(0, 0, mapWidth, mapHeight);
      this.cameras.main.setZoom(0.5);

      if (player) {
        this.physics.add.collider(player, layer, handleTileCollision, null, this);
      }
      this.physics.add.collider(otherPlayers, layer);
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
    otherPlayers.getChildren().forEach((otherPlayer) => {
      if (playerInfo.id === otherPlayer.id) {
        // If state changed, update alignment
        if (otherPlayer.state !== playerInfo.state) {
          applyPlayerState(otherPlayer, playerInfo.state);
        }
        otherPlayer.targetX = playerInfo.x;
        otherPlayer.targetY = playerInfo.y;
        otherPlayer.flipX = playerInfo.flipX;
        if (playerInfo.anim) otherPlayer.anims.play(playerInfo.anim, true);
      }
    });
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

  this.items = this.physics.add.group();

  socket.on('initItems', (items) => {
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
    }
  });

  this.add.text(10, 10, 'Use Arrows to move.', { fill: '#ffffff' }).setScrollFactor(0);
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

  scene.anims.create({ key: 'die', frames: [{ key: 'mario', frame: 'die' }], frameRate: 10 });
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
    scene.physics.add.collider(player, layer, handleTileCollision, null, scene);
  }

  player.body.setDragX(DRAG);
  player.body.setMaxVelocity(RUN_MAX_VELOCITY, 1100);
  scene.cameras.main.startFollow(player, true);
}

function addOtherPlayers(scene, playerInfo) {
  const otherPlayer = scene.physics.add.sprite(playerInfo.x, playerInfo.y, 'mario').setScale(4);
  otherPlayer.id = playerInfo.id;
  otherPlayer.targetX = playerInfo.x;
  otherPlayer.targetY = playerInfo.y;
  otherPlayer.body.setAllowGravity(false); // Server/Owner handles their physics
  applyPlayerState(otherPlayer, playerInfo.state || 0);
  if (playerInfo.anim) otherPlayer.anims.play(playerInfo.anim, true);
  otherPlayers.add(otherPlayer);
}

let lastEmitTime = 0;
const EMIT_THRESHOLD_MS = 33;
const MOVE_THRESHOLD = 0.5;

function update(time, delta) {
  otherPlayers.getChildren().forEach((otherPlayer) => {
    if (otherPlayer.targetX !== undefined && otherPlayer.targetY !== undefined) {
      const lerpFactor = 0.15;
      const newX = Phaser.Math.Linear(otherPlayer.x, otherPlayer.targetX, lerpFactor);
      const newY = Phaser.Math.Linear(otherPlayer.y, otherPlayer.targetY, lerpFactor);
      otherPlayer.setPosition(newX, newY);

      // Apply jump frame offsets
      const isJumping = otherPlayer.anims.currentAnim && otherPlayer.anims.currentAnim.key.includes('jump');

      if (isJumping) {
        if (otherPlayer.flipX) {
          otherPlayer.setOffset(0, 0);
        } else {
          otherPlayer.setOffset(4, 0);
        }
      } else {
        otherPlayer.setOffset(0, 0);
      }
    }
  });

  if (player && player.body) {
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
        if (absVelocityX < 10) player.anims.play(getAnimKey('idle', state), true);
        else player.anims.play(getAnimKey('walk', state), true);
      }
    }

    if (cursors.up.isDown && isGrounded) player.setVelocityY(JUMP_FORCE);
    if (!cursors.up.isDown && player.body.velocity.y < 0) player.setVelocityY(player.body.velocity.y * VARIABLE_JUMP_MODIFIER);
    
    if (!isGrounded && Math.abs(player.body.velocity.y) > 20) {
      player.anims.play(getAnimKey('jump', state), true);
      // Fix "skinnier" hitbox for 20px jump frames
      if (player.flipX) {
        player.setOffset(0, 0);
      } else {
        player.setOffset(4, 0);
      }
    } else if (isGrounded) {
      player.setOffset(0, 0);
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
      state !== player.oldPosition.state;

    if (hasMovedSignificantly && now - lastEmitTime > EMIT_THRESHOLD_MS) {
      socket.emit('playerMovement', { x, y, anim, flipX, state });
      lastEmitTime = now;
      player.oldPosition = { x, y, anim, flipX, state };
    }
  }
}
