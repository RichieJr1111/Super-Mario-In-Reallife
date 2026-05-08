import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../database.sqlite');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: dbPath,
    logging: console.log
});

const HighScore = sequelize.define('HighScore', {
    levelId: { type: DataTypes.STRING, defaultValue: 'world-1-1' },
    playerName: { type: DataTypes.STRING, defaultValue: 'Mario' },
    timeMs: { type: DataTypes.INTEGER, allowNull: false },
    score: { type: DataTypes.INTEGER, defaultValue: 0 }
});

async function resetLeaderboards() {
    try {
        console.log('Connecting to database...');
        await sequelize.authenticate();
        console.log('Connected. Removing all leaderboard entries...');
        
        // Use destroy with no where clause to delete all rows
        const deletedCount = await HighScore.destroy({
            where: {},
            truncate: true
        });
        
        console.log(`Successfully removed leaderboard entries.`);
        process.exit(0);
    } catch (error) {
        console.error('Error resetting leaderboards:', error);
        process.exit(1);
    }
}

resetLeaderboards();
