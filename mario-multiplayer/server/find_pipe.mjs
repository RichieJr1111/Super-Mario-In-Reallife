import { MAPS } from './map.js';

const level = MAPS['world-1-1'].data;
const x = 164;

for (let y = 0; y < level.length; y++) {
    console.log(`Row ${y}: ${level[y][x-1]}${level[y][x]}${level[y][x+1]}`);
}
