// Manual test for authentication endpoints
// This can be tested using curl or Postman

// Test 1: Sign Up
// POST http://localhost:3000/api/auth/signup
// Content-Type: application/json
// {
//   "username": "testplayer",
//   "email": "test@example.com",
//   "password": "password123"
// }

// Expected Response (201):
// {
//   "message": "User created successfully",
//   "userId": 1,
//   "username": "testplayer"
// }

// Test 2: Login with correct credentials
// POST http://localhost:3000/api/auth/login
// Content-Type: application/json
// {
//   "username": "testplayer",
//   "password": "password123"
// }

// Expected Response (200):
// {
//   "message": "Login successful",
//   "userId": 1,
//   "username": "testplayer",
//   "email": "test@example.com"
// }

// Test 3: Login with incorrect password
// POST http://localhost:3000/api/auth/login
// Content-Type: application/json
// {
//   "username": "testplayer",
//   "password": "wrongpassword"
// }

// Expected Response (401):
// {
//   "error": "Invalid username or password"
// }

// Test 4: Sign up with duplicate username
// POST http://localhost:3000/api/auth/signup
// Content-Type: application/json
// {
//   "username": "testplayer",
//   "email": "another@example.com",
//   "password": "password123"
// }

// Expected Response (409):
// {
//   "error": "Username already exists"
// }

console.log('Authentication API Test Guide');
console.log('=============================');
console.log('');
console.log('Use curl or Postman to test these endpoints after starting the server:');
console.log('');
console.log('1. Sign Up:');
console.log('curl -X POST http://localhost:3000/api/auth/signup \\');
console.log('  -H "Content-Type: application/json" \\');
console.log('  -d \'{"username":"testplayer","email":"test@example.com","password":"password123"}\'');
console.log('');
console.log('2. Login:');
console.log('curl -X POST http://localhost:3000/api/auth/login \\');
console.log('  -H "Content-Type: application/json" \\');
console.log('  -d \'{"username":"testplayer","password":"password123"}\'');
