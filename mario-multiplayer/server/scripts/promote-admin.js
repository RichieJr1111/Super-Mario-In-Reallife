import { Sequelize, DataTypes } from 'sequelize';

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false
});

const User = sequelize.define('User', {
    username: { type: DataTypes.STRING, allowNull: false, unique: true },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    isAdmin: { type: DataTypes.BOOLEAN, defaultValue: false }
});

async function promote(username) {
    try {
        await sequelize.authenticate();
        const user = await User.findOne({ where: { username } });
        if (!user) {
            console.error(`User "${username}" not found.`);
            process.exit(1);
        }
        user.isAdmin = true;
        await user.save();
        console.log(`User "${username}" has been promoted to Admin.`);
    } catch (error) {
        console.error('Error promoting user:', error);
    } finally {
        await sequelize.close();
    }
}

const username = process.argv[2];
if (!username) {
    console.log('Usage: node promote-admin.js <username>');
    process.exit(1);
}

promote(username);
