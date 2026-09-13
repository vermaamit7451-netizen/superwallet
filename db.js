const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/superwallet';

async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  });
  console.log('MongoDB connected.');
}

module.exports = { mongoose, connectDatabase };
