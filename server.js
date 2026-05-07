// Root-level entry point for Render deployment
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build the client first
console.log('Building client...');
try {
  execSync('npm install', { cwd: path.join(__dirname, 'mario-multiplayer/client'), stdio: 'inherit' });
  execSync('npm run build', { cwd: path.join(__dirname, 'mario-multiplayer/client'), stdio: 'inherit' });
} catch (e) {
  console.error('Client build failed:', e.message);
}

// Start the server
console.log('Starting server...');
const serverPath = path.join(__dirname, 'mario-multiplayer/server/index.js');
import(serverPath).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
