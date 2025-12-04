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

// Test data
const maps = ['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Karakin', 'Livik'];
const modes = ['clash_squad', 'battle_royal', 'lone_wolf'];
const teamSizes = ['1vs1', '2v2', '4v4', '6v6'];

function generateTournamentId(mode, index) {
  const prefixes = {
    'clash_squad': 'CSQ',
    'battle_royal': 'BR',
    'lone_wolf': 'LW'
  };
  return `${prefixes[mode]}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(index).padStart(3, '0')}`;
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function generateRandomTournament(index) {
  const mode = getRandomElement(modes);
  const map = getRandomElement(maps);

  let maxSlots, teamSize;
  if (mode === 'battle_royal') {
    maxSlots = 48;
    teamSize = undefined;
  } else {
    maxSlots = Math.floor(Math.random() * 95) + 10; // 10-100 slots
    teamSize = getRandomElement(teamSizes);
  }

  const entryFee = Math.floor(Math.random() * 50) + 5; // $5-55
  const winningFee = entryFee * maxSlots * 0.8; // 80% of total entry fees

  // Generate start time (next 1-7 days)
  const startTime = new Date();
  startTime.setDate(startTime.getDate() + Math.floor(Math.random() * 7) + 1);
  startTime.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), 0, 0);

  // Generate prizes
  const prizes = {
    top5: [winningFee * 0.3, winningFee * 0.2, winningFee * 0.15, winningFee * 0.1, winningFee * 0.05],
    top10: Array(5).fill().map((_, i) => winningFee * (0.04 - i * 0.005)),
    perKill: Math.floor(winningFee * 0.01)
  };

  return {
    tournamentId: generateTournamentId(mode, index),
    map,
    mode,
    teamSize,
    entryFee,
    winningFee,
    maxSlots,
    startTime,
    status: 'upcoming',
    banner: `ff${Math.floor(Math.random() * 6) + 1}.jpg`,
    prizes
  };
}

async function generateTestTournaments(count = 10) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const tournaments = [];
    for (let i = 1; i <= count; i++) {
      tournaments.push(generateRandomTournament(i));
    }

    const result = await Tournament.insertMany(tournaments);
    console.log(`Generated ${result.length} test tournaments:`);

    result.forEach(tournament => {
      console.log(`- ${tournament.tournamentId}: ${tournament.mode} on ${tournament.map}, $${tournament.entryFee} entry, ${tournament.maxSlots} slots`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error generating test tournaments:', error);
    process.exit(1);
  }
}

// Generate 10 test tournaments by default
const count = process.argv[2] ? parseInt(process.argv[2]) : 10;
generateTestTournaments(count);