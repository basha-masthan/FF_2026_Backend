const mongoose = require('mongoose');
require('dotenv').config();

// Tournament Schema (same as in server.js)
const tournamentSchema = new mongoose.Schema({
  tournamentId: { type: String, required: true, unique: true },
  map: { type: String, required: true },
  mode: {
    type: String,
    required: true,
    enum: ['clash_squad', 'battle_royal', 'lone_wolf'],
    validate: {
      validator: function(value) {
        if (value === 'battle_royal' && this.maxSlots !== 48) {
          return false;
        }
        return true;
      },
      message: 'Battle Royal tournaments must have exactly 48 slots'
    }
  },
  teamSize: {
    type: String,
    enum: ['1vs1', '2v2', '4v4', '6v6'],
    required: function() {
      return this.mode === 'clash_squad' || this.mode === 'lone_wolf';
    }
  },
  entryFee: { type: Number, required: true, min: 0 },
  winningFee: { type: Number, required: true, min: 0 },
  maxSlots: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: function(value) {
        if (this.mode === 'battle_royal') {
          return value === 48;
        }
        return true;
      },
      message: 'Battle Royal tournaments must have exactly 48 slots'
    }
  },
  registeredPlayers: { type: Number, default: 0 },
  startTime: { type: Date, required: true },
  status: { type: String, enum: ['upcoming', 'active', 'completed'], default: 'upcoming' },
  banner: { type: String, default: 'default.jpg' },
  roomId: { type: String, default: '' },
  roomPassword: { type: String, default: '' },
  prizes: {
    top5: [Number],
    top10: [Number],
    perKill: Number
  },
  registeredUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const Tournament = mongoose.model('Tournament', tournamentSchema);

async function deleteAllTournaments() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const result = await Tournament.deleteMany({});
    console.log(`Deleted ${result.deletedCount} tournaments`);

    process.exit(0);
  } catch (error) {
    console.error('Error deleting tournaments:', error);
    process.exit(1);
  }
}

deleteAllTournaments();