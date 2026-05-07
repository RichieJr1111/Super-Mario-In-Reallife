// ==========================
// TILE DEFINITIONS (1024x1024 tileset, 16 tiles per row)
// ==========================
export const TILE = {
  EMPTY: -1,

  // Blocks
  BRICK: 1,
  QUESTION: 129,
  HIT_QUESTION: 136,

  // Pipes
  PIPE_TOP_LEFT: 94,
  PIPE_TOP_RIGHT: 95,
  PIPE_BODY_LEFT: 110,
  PIPE_BODY_RIGHT: 111,

  // Ground
  GROUND_TOP: 145,
  GROUND_FILL: 160,
  HARD_BLOCK: 33, // Brown stone block for stairs
  FLAG_POLE: 247  // Placeholder for flagpole tile
};

// ==========================
// MAP DATA (VGLC format)
// ==========================
const WORLD_1_1 = [
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------E----------------------------------------------------------------------------------------------------------X--------F---",
  "----------------------Q---------------------------------------------------------SSSSSSSS---SSSQ--------C-C--*---?--------SSS----SQQS--------------------------------------------------------XX--------F---",
  "-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------XXX--------F---",
  "-------------------------------------------------------------------------------E----------------------------------------------------------------------------------------------------------XXXX--------F---",
  "----------------------------------------------------------------S------------------------------------------------------------------------------------------------------------------------XXXXX--------F---",
  "----------------Q---S?SQS---------------------<>---------<>------------------S?S--------------S-----SS----Q---Q---Q---S----------SS------X--X----------XX--X------------SSQS------------XXXXXX--------F---",
  "--------------------------------------<>------[]---------[]-----------------------------------------------------------------------------XX--XX--------XXX--XX--------------------------XXXXXXX--------F---",
  "----------------------------<>--------[]------[]---------[]----------------------------------------------------------------------------XXX--XXX------XXXX--XXX-----<>--------------<>-XXXXXXXX--------F---",
  "---------------------E------[]--------[]-E----[]-----E-E-[]------------------------------------E-E--------E-----------------EE-E-E----XXXX--XXXX----XXXXX--XXXX----[]---------EE---[]XXXXXXXXX--------F---",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX--XXXXXXXXXXXXXXX---XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX--XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

const UNDERGROUND = [
  "---<>---------------------------------",
  "---[]---------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "--------------------------------------",
  "-----------C---C-----C----------------",
  "-----------C---C----------------------",
  "-----------CCCCC-----C----------------",
  "-----------C---C-----C----------------",
  "-----<>----C---C-----C--------<>------",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

const WORLD_1_2 = [
  "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
  "S-----------------------------------------------------------------------------------------------------------------------------------------------------S",
  "S-----------------------------------------------------------------------------------------------------------------------------------------------------S",
  "S---------SSSSSSS--------------------SSSSSSSSSSSSSSSSSSSSSSSSS----------------------SSSSSSSSSSSSSSSSSSSSSSSSS-----------------------------------------S",
  "S-----------------------------------------------------------------------------------------------------------------------------------------------------S",
  "S-------------------------EE--------------------------------------------------------------------------------------------------------------------------S",
  "S---------SSSSSSS---------<>---------SSSSSSS-----------SSSSSSS-----------<>---------SSSSSSS-----------SSSSSSS-----------<>----------------------------S",
  "S---------S-----S---------[]---------S-----S-----------S-----S-----------[]---------S-----S-----------S-----S-----------[]----------------------F-----S",
  "S---------S-CCC-S---------[]---------S-CCC-S-----------S-CCC-S-----------[]---------S-CCC-S-----------S-CCC-S-----------[]-----------X----------F-----S",
  "S----E----S-Q*Q-S-----E---[]----E----S-Q*Q-S-----E-----S-?Q?-S-----E-----[]----E----S-Q*Q-S-----E-----S-?Q?-S-----E-----[]----------XX----------F-----S",
  "S--SSS----S-----S---SSS---[]--SSS----S-----S----SSS----S-----S----SSS----[]--SSS----S-----S----SSS----S-----S----SSS----[]---------XXX----------F-----S",
  "S---------S-----S---------[]---------S-----S-----------S-----S-----------[]---------S-----S-----------S-----S-----------[]--------XXXX----------F-----S",
  "S---------SSS-SSS---------[]---------SSS-SSS-----------SSS-SSS-----------[]---------SSS-SSS-----------SSS-SSS-----------[]-------XXXXX----------F-----S",
  "S-----E------------E------[]-----E------------E--------------------------[]-----E------------E--------------------------[]------XXXXXX----------F-----S",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

const BATTLE_ARENA = [
  "--------------------------------------------------",
  "--------------------------------------------------",
  "-----------?----------*----------?----------------",
  "--------------------------------------------------",
  "--------------------------------------------------",
  "-----------SS----SS---SS----SS---SS---------------",
  "-----<>----------------------------------<>-------",
  "-----[]----------C---C---C---C-----------[]-------",
  "--SSSSSSSS----------------------------SSSSSSSS----",
  "------------------SSSSSSSSSS----------------------",
  "---C---C---C---C---C---C---C---C---C---C---C------",
  "--------------------------------------------------",
  "---E---SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS------E---",
  "---S------------------------------------------S---",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

const SKY_RACE = [
  "------------------------------------------------------------------------------------------------------------------------------------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "------------------S*S-------------------------------------------S?S-------------------------------------------S*S------------------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "---------SSS-----------------SSS-----------------------SSS-----------------SSS-----------------------SSS-----------------SSS--------",
  "------------------------------------------------------------------------------------------------------------------------------------",
  "-------------------E------------------------------------E---------------------------------------------E----------------------------",
  "----X-----------X-----------X-----------X-----------X-----------X-----------X-----------X-----------X-----------X-----------X---F-",
  "---XXX---------XXX---------XXX---------XXX---------XXX---------XXX---------XXX---------XXX---------XXX---------XXX---------XXX--F-",
  "----------------------------------------------------------------------------------------------------------------------------------F-",
  "----------------------------------------------------------------------------------------------------------------------------------F-",
  "----------------------------------------------------------------------------------------------------------------------------------F-"
];

export const MAPS = {
  'world-1-1': {
    data: WORLD_1_1,
    warps: {
      '57,9': { target: 'underground', x: 256, y: 192, warpType: 'pipe-down', spawnType: 'pipe-down' }, // 4th pipe
      '58,9': { target: 'underground', x: 256, y: 192, warpType: 'pipe-down', spawnType: 'pipe-down' }
    },
    spawn: { x: 150, y: 700 }
  },
  'underground': {
    data: UNDERGROUND,
    warps: {
      '30,13': { target: 'world-1-1', x: 10496, y: 672, warpType: 'pipe-down', spawnType: 'pipe-up' },
      '31,13': { target: 'world-1-1', x: 10496, y: 672, warpType: 'pipe-down', spawnType: 'pipe-up' }
    },
    spawn: { x: 256, y: 65, spawnType: 'pipe-down' }
  },
  'world-1-2': {
    data: WORLD_1_2,
    warps: {},
    spawn: { x: 150, y: 700 }
  },
  'battle-arena': {
    data: BATTLE_ARENA,
    warps: {},
    spawn: { x: 150, y: 700 }
  },
  'sky-race': {
    data: SKY_RACE,
    warps: {},
    spawn: { x: 150, y: 500 }
  }
};

export const ITEM_TYPES = {
  NONE: 'none',
  COIN: 'coin',
  MUSHROOM: 'mushroom',
  FIRE_FLOWER: 'fire_flower',
  STAR: 'star',
  PHYS_COIN: 'phys_coin'
};

const TILE_MAP = {
  '-': TILE.EMPTY,
  'X': TILE.GROUND_TOP, // Default to ground, handle logic in builder
  'S': TILE.BRICK,
  'Q': TILE.QUESTION,
  '?': TILE.QUESTION,
  '*': TILE.QUESTION,
  '<': TILE.PIPE_TOP_LEFT,
  '>': TILE.PIPE_TOP_RIGHT,
  '[': TILE.PIPE_BODY_LEFT,
  ']': TILE.PIPE_BODY_RIGHT,
  'F': TILE.FLAG_POLE,
  'E': TILE.EMPTY, // Enemies are entities, skip in static map
  'C': TILE.EMPTY
};

// Map symbols to default item contents
const BLOCK_CONTENT_MAP = {
  'Q': ITEM_TYPES.COIN,
  '?': ITEM_TYPES.MUSHROOM,
  '*': ITEM_TYPES.STAR
};

export const WIDTH = WORLD_1_1[0].length;
export const HEIGHT = 15;

/**
 * Returns the item content for a specific block symbol in a map.
 */
export function getBlockContent(x, y, levelId = 'world-1-1', playerState = 0) {
  const mapData = MAPS[levelId].data;
  if (y < 0 || y >= mapData.length) return ITEM_TYPES.NONE;
  const char = mapData[y][x];
  let content = BLOCK_CONTENT_MAP[char] || ITEM_TYPES.NONE;

  if (content === ITEM_TYPES.MUSHROOM && playerState >= 1) {
    content = ITEM_TYPES.FIRE_FLOWER;
  }
  return content;
}

// ==========================
// BUILD LEVEL (PARSER)
// ==========================
export function buildLevel(levelId = 'world-1-1') {
  const mapData = MAPS[levelId].data;
  // Levels that should have the automatic "ground fill" at the bottom
  const needsGroundFill = ['world-1-1', 'world-1-2', 'underground', 'battle-arena'];
  const hasFill = needsGroundFill.includes(levelId);

  const height = mapData.length + (hasFill ? 1 : 0);
  const width = mapData[0].length;

  const map = Array.from({ length: height }, () => Array(width).fill(TILE.EMPTY));

  for (let y = 0; y < mapData.length; y++) {
    const row = mapData[y];
    for (let x = 0; x < width; x++) {
      const char = row[x];
      if (!char) continue;
      let tileIndex = TILE_MAP[char] || TILE.EMPTY;

      if (char === 'X') {
        if (y === mapData.length - 1 && hasFill) {
          tileIndex = TILE.GROUND_TOP;
          map[y + 1][x] = TILE.GROUND_FILL;
        } else {
          tileIndex = TILE.HARD_BLOCK;
        }
      }

      map[y][x] = tileIndex;
    }
  }

  return {
    data: map,
    width,
    height,
    levelId
  };
}

export function flattenMap(map) {
  return map.flat();
}

export const mapConfig = buildLevel('world-1-1');

/**
 * Parses the map and returns initial spawn points for enemies.
 */
export function getEnemySpawns(levelId = 'world-1-1') {
  const mapData = MAPS[levelId].data;
  const spawns = [];
  for (let y = 0; y < mapData.length; y++) {
    const row = mapData[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'E') {
        spawns.push({
          x: x * 64 + 32,
          y: y * 64 + 32,
          type: 'goomba'
        });
      }
    }
  }
  return spawns;
}

/**
 * Parses the map and returns initial spawn points for persistent items (like physical coins).
 */
export function getItemSpawns(levelId = 'world-1-1') {
  const mapData = MAPS[levelId].data;
  const spawns = [];
  for (let y = 0; y < mapData.length; y++) {
    const row = mapData[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'C') {
        spawns.push({
          x: x * 64 + 32,
          y: y * 64 + 32,
          type: ITEM_TYPES.PHYS_COIN
        });
      }
    }
  }
  return spawns;
}