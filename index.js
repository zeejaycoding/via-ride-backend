const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
const placesRouter = require('./routes/places');
app.use('/api/places', placesRouter);
const tripRouter = require('./routes/trip');
app.use('/api/trip', tripRouter);
const driversRouter = require('./routes/drivers');
app.use('/api/drivers', driversRouter);

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || '';

async function start() {
  if (!MONGO_URI) {
    console.warn('MONGO_URI not set. Connect to MongoDB by adding MONGO_URI to .env');
  }

  try {
    if (MONGO_URI) await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
