# Super CSE108 Multiplayer

![Super Mario Multiplayer Banner](https://img.shields.io/badge/Status-Active-brightgreen)
![Phaser](https://img.shields.io/badge/Phaser-3.90.0-blue)
![Socket.io](https://img.shields.io/badge/Socket.io-4.8.3-black)
![Node.js](https://img.shields.io/badge/Node.js-18+-green)

Welcome to **Super CSE108 Multiplayer**, a modern reimagining of the classic Mario experience, built from the ground up for competitive and cooperative online play. This project was developed as the final capstone for CSE108.

## 🚀 Features

### 🎮 Gameplay Modes
- **Single-player:** Experience the classic Mario levels on your own, including Normal and Speedrun modes.
- **Multiplayer Co-op:** Team up with friends to take down Bowser's minions.
- **Competitive PvP:** Race to the finish line and compete for the highest score.
- **Spectator Mode:** Died early? No problem. Watch your friends finish the level with our real-time spectator camera.

### 🎨 Customization & Skins
- **Skin Selection:** Choose from various character skins including Mario, Luigi, Jacob, and Sean.
- **Chaos & Random Skins:** Dynamic skin generation that randomizes textures and colors every level.
- **Chroma Settings:** Real-time color customization with primary and secondary color pickers and a live preview.
- **Interactive Lobby:** Wait for your friends in a dedicated lobby where you can chat and customize your character.

### 📈 Social & Competitive
- **Global Leaderboards:** Track your best times and high scores across different levels and modes.
- **User Authentication:** Secure account system to save your progress and compete on the leaderboards.
- **Admin Panel:** Powerful administrative tools for managing users and scores.
- **Real-time Chat:** Communicate with other players in the lobby and during the game.

## 🛠️ Technology Stack

- **Frontend:** [Phaser 3](https://phaser.io/) (Game Engine), [Vite](https://vitejs.dev/) (Build Tool), Vanilla CSS.
- **Backend:** [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [Socket.io](https://socket.io/) (Real-time communication).
- **Database:** [SQLite](https://www.sqlite.org/) with [Sequelize ORM](https://sequelize.org/).
- **Authentication:** [Bcryptjs](https://www.npmjs.com/package/bcryptjs) for secure password hashing.

## 🔧 Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

### Step-by-Step Guide

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd "CSE108 Final Project"
   ```

2. **Install dependencies:**
   Run the following command in the root directory to install dependencies for both the client and server using npm workspaces:
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Navigate to the `mario-multiplayer/server` directory and create a `.env` file based on `.env.example`.
   ```bash
   cd mario-multiplayer/server
   cp .env.example .env
   ```

4. **Run the application:**
   Return to the root directory and start both the client and server in development mode:
   ```bash
   # From the root directory
   npm run dev:server
   npm run dev:client
   ```

5. **Access the game:**
   Open your browser and navigate to `http://localhost:5173` (or the port specified by Vite).

## 📁 Project Structure

```text
.
├── mario-multiplayer/
│   ├── client/          # Phaser game code, assets, and Vite config
│   │   ├── src/         # Main game logic and components
│   │   ├── public/      # Static assets (images, audio, JSON maps)
│   │   └── index.html   # Main entry point for the frontend
│   └── server/          # Node.js backend logic
│       ├── auth.js      # User authentication logic
│       ├── map.js       # Game world and physics state management
│       ├── index.js     # Socket.io event handling and server entry point
│       └── scripts/     # Utility scripts (e.g., reset leaderboards)
├── package.json         # Root workspace configuration
└── render.yaml          # Deployment configuration for Render
```

## 👥 Credits

This project was created with ❤️ by **A-Team-Geckos**:

- **Richie Friedland**
- **Shruthi Rao**
- **Sean Grant**
- **Ethan Change**

## 📄 License

This project is licensed under the **ISC License**. See the `package.json` files for more details.
