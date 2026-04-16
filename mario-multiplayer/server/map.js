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
// VGLC RAW MAP DATA (World 1-1)
// ==========================
const VGLC_MAP = [
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
  "----------------------------------------------------------------------------------E----------------------------------------------------------------------------------------------------------X--------F---",
  "----------------------Q---------------------------------------------------------SSSSSSSS---SSSQ------------*---?-----------SSS----SQQS------------------------------------------------------XX--------F---",
  "-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------XXX--------F---",
  "-------------------------------------------------------------------------------E----------------------------------------------------------------------------------------------------------XXXX--------F---",
  "----------------------------------------------------------------S------------------------------------------------------------------------------------------------------------------------XXXXX--------F---",
  "----------------Q---S?SQS---------------------<>---------<>------------------S?S--------------S-----SS----Q--Q--Q-----S----------SS------X--X----------XX--X------------SSQS------------XXXXXX--------F---",
  "--------------------------------------<>------[]---------[]-----------------------------------------------------------------------------XX--XX--------XXX--XX--------------------------XXXXXXX--------F---",
  "----------------------------<>--------[]------[]---------[]----------------------------------------------------------------------------XXX--XXX------XXXX--XXX-----<>--------------<>-XXXXXXXX--------F---",
  "---------------------E------[]--------[]-E----[]-----E-E-[]------------------------------------E-E--------E-----------------EE-E-E----XXXX--XXXX----XXXXX--XXXX----[]---------EE---[]XXXXXXXXX--------F---",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX--XXXXXXXXXXXXXXX---XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX--XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

export const ITEM_TYPES = {
  NONE: 'none',
  COIN: 'coin',
  MUSHROOM: 'mushroom',
  FIRE_FLOWER: 'fire_flower',
  STAR: 'star'
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
  'E': TILE.EMPTY // Enemies are entities, skip in static map
};

// Map symbols to default item contents
const BLOCK_CONTENT_MAP = {
  'Q': ITEM_TYPES.COIN,
  '?': ITEM_TYPES.MUSHROOM,
  '*': ITEM_TYPES.STAR
};

// ==========================
// MAP SETTINGS
// ==========================
export const WIDTH = VGLC_MAP[0].length;
export const HEIGHT = 15; // 14 layers in VGLC + 1 layer ground fill

/**
 * Returns the item content for a specific block symbol in the VGLC map.
 * If playerState is provided (>= 1), mushrooms turn into fire flowers.
 */
export function getBlockContent(x, y, playerState = 0) {
  if (y < 0 || y >= VGLC_MAP.length) return ITEM_TYPES.NONE;
  const char = VGLC_MAP[y][x];
  let content = BLOCK_CONTENT_MAP[char] || ITEM_TYPES.NONE;

  // Upgrade Mushroom to Fire Flower if player is already big
  if (content === ITEM_TYPES.MUSHROOM && playerState >= 1) {
    content = ITEM_TYPES.FIRE_FLOWER;
  }

  return content;
}

// ==========================
// BUILD LEVEL (PARSER)
// ==========================
export function buildLevel() {
  const map = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(TILE.EMPTY));

  for (let y = 0; y < VGLC_MAP.length; y++) {
    const row = VGLC_MAP[y];
    for (let x = 0; x < WIDTH; x++) {
      const char = row[x];
      let tileIndex = TILE_MAP[char] || TILE.EMPTY;

      // Special Logic for 'X'
      if (char === 'X') {
        if (y === 13) {
          tileIndex = TILE.GROUND_TOP;
          // Add fill below ground
          map[14][x] = TILE.GROUND_FILL;
        } else {
          tileIndex = TILE.HARD_BLOCK; // Pyramid/Stair blocks
        }
      }

      map[y][x] = tileIndex;
    }
  }

  return map;
}

export function flattenMap(map) {
  return map.flat();
}

export const mapConfig = {
  width: WIDTH,
  height: HEIGHT,
  data: buildLevel()
};

/**
 * Parses the VGLC_MAP and returns initial spawn points for enemies.
 */
export function getEnemySpawns() {
  const spawns = [];
  for (let y = 0; y < VGLC_MAP.length; y++) {
    const row = VGLC_MAP[y];
    for (let x = 0; x < WIDTH; x++) {
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