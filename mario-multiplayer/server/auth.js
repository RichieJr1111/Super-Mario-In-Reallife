import express from 'express';
import bcryptjs from 'bcryptjs';
import crypto from 'crypto';

const router = express.Router();
const SALT_ROUNDS = 10;

export function setupAuthRoutes(app, User) {
    // Sign Up
    app.post('/api/auth/signup', async (req, res) => {
        try {
            const { username, email, password } = req.body;

            // Validation
            if (!username || !email || !password) {
                return res.status(400).json({ error: 'Username, email, and password are required' });
            }

            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }

            // Check if user already exists
            const existingUser = await User.findOne({
                where: { username }
            });

            if (existingUser) {
                return res.status(409).json({ error: 'Username already exists' });
            }

            // Hash password
            const passwordHash = await bcryptjs.hash(password, SALT_ROUNDS);

            // Create user
            const newUser = await User.create({
                username,
                email,
                passwordHash
            });

            res.status(201).json({
                message: 'User created successfully',
                userId: newUser.id,
                username: newUser.username
            });
        } catch (error) {
            console.error('Signup error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Login
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password, rememberMe } = req.body;

            // Validation
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }

            // Find user
            const user = await User.findOne({
                where: { username }
            });

            if (!user) {
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            // Compare password
            const passwordMatch = await bcryptjs.compare(password, user.passwordHash);

            if (!passwordMatch) {
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            let sessionToken = null;
            if (rememberMe) {
                sessionToken = crypto.randomBytes(32).toString('hex');
                await user.update({ sessionToken });
            }

            res.json({
                message: 'Login successful',
                userId: user.id,
                username: user.username,
                email: user.email,
                isAdmin: user.isAdmin,
                sessionToken: sessionToken
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Auto-Login (Token Verification)
    app.post('/api/auth/auto-login', async (req, res) => {
        try {
            const { username, sessionToken } = req.body;

            if (!username || !sessionToken) {
                return res.status(400).json({ error: 'Username and token are required' });
            }

            const user = await User.findOne({
                where: { username, sessionToken }
            });

            if (!user) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            res.json({
                message: 'Auto-login successful',
                userId: user.id,
                username: user.username,
                email: user.email,
                isAdmin: user.isAdmin
            });
        } catch (error) {
            console.error('Auto-login error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}

export default router;
