const mongoose = require('mongoose');
require('dotenv').config();

// User Schema
const userSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  mobile: { type: String, default: '' },
  age: { type: Number, default: null },
  state: { type: String, default: '' },
  winningAmount: { type: Number, default: 0 },
  depositAmount: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// Tournament Schema
const tournamentSchema = new mongoose.Schema({
  tournamentId: { type: String, required: true, unique: true },
  map: { type: String, required: true },
  mode: {
    type: String,
    required: true,
    enum: ['clash_squad', 'battle_royal', 'lone_wolf']
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
  maxSlots: { type: Number, required: true, min: 1 },
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

// Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    required: true,
    enum: ['deposit', 'winning', 'entry_fee', 'withdrawal']
  },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  reference: { type: String, required: true },
  referenceType: {
    type: String,
    required: true,
    enum: ['payment_id', 'tournament_id', 'withdrawal_id']
  },
  status: {
    type: String,
    enum: ['completed', 'pending', 'failed'],
    default: 'completed'
  },
  metadata: {
    tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
    paymentId: String,
    razorpayOrderId: String,
    position: Number
  },
  createdAt: { type: Date, default: Date.now }
});

transactionSchema.index({ userId: 1, reference: 1, referenceType: 1 }, { unique: true });
const Transaction = mongoose.model('Transaction', transactionSchema);

async function logTransaction(userId, type, amount, description, reference, referenceType, metadata = {}) {
  try {
    const existingTransaction = await Transaction.findOne({
      userId,
      reference,
      referenceType
    });

    if (existingTransaction) {
      console.log(`Transaction already exists: ${reference}`);
      return existingTransaction;
    }

    const transaction = new Transaction({
      userId,
      type,
      amount,
      description,
      reference,
      referenceType,
      metadata,
      status: 'completed'
    });

    await transaction.save();
    console.log(`Transaction logged: ${type} - ${amount} - ${reference}`);
    return transaction;
  } catch (error) {
    console.error('Error logging transaction:', error);
    throw error;
  }
}

async function testTournamentRegistration() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Create a test user with sufficient balance
    const testUser = new User({
      fullname: 'Test User',
      email: 'test@example.com',
      password: 'hashedpassword',
      depositAmount: 100, // $100 balance
      winningAmount: 50   // $50 winning balance
    });

    await testUser.save();
    console.log('Created test user:', testUser._id);

    // Find a tournament to register for
    const tournament = await Tournament.findOne({ status: 'upcoming' }).sort({ entryFee: 1 });
    if (!tournament) {
      console.log('No upcoming tournaments found');
      return;
    }

    console.log('Testing registration for tournament:', tournament.tournamentId);
    console.log('Entry fee:', tournament.entryFee);
    console.log('User balance:', testUser.depositAmount + testUser.winningAmount);

    // Check balance
    const totalBalance = testUser.depositAmount + testUser.winningAmount;
    if (totalBalance < tournament.entryFee) {
      console.log('Insufficient balance for registration');
      return;
    }

    // Deduct from accounts: deposit first, then winning
    let remainingFee = tournament.entryFee;
    let deductedFromDeposit = 0;
    let deductedFromWinning = 0;

    if (testUser.depositAmount >= remainingFee) {
      deductedFromDeposit = remainingFee;
      testUser.depositAmount -= remainingFee;
      remainingFee = 0;
    } else {
      deductedFromDeposit = testUser.depositAmount;
      remainingFee -= testUser.depositAmount;
      testUser.depositAmount = 0;
    }

    if (remainingFee > 0) {
      if (testUser.winningAmount >= remainingFee) {
        deductedFromWinning = remainingFee;
        testUser.winningAmount -= remainingFee;
        remainingFee = 0;
      } else {
        console.log('Balance calculation error');
        return;
      }
    }

    // Save user balance update
    await testUser.save();

    // Log the entry fee transaction
    try {
      await logTransaction(
        testUser._id,
        'entry_fee',
        -tournament.entryFee,
        `Entry fee for tournament: ${tournament.tournamentId}`,
        tournament._id.toString(),
        'tournament_id',
        {
          tournamentId: tournament._id
        }
      );
    } catch (transactionError) {
      console.error('Error logging entry fee transaction:', transactionError);
    }

    // Add user to registered users and increment count
    tournament.registeredUsers.push(testUser._id);
    tournament.registeredPlayers += 1;
    await tournament.save();

    console.log('✅ Registration successful!');
    console.log('Tournament:', tournament.tournamentId);
    console.log('User:', testUser.fullname);
    console.log('Deducted from deposit:', deductedFromDeposit);
    console.log('Deducted from winning:', deductedFromWinning);
    console.log('New balance:', testUser.depositAmount + testUser.winningAmount);

    // Verify the registration
    const updatedTournament = await Tournament.findById(tournament._id);
    const isRegistered = updatedTournament.registeredUsers.includes(testUser._id);

    console.log('Registration verified:', isRegistered);
    console.log('Total registered players:', updatedTournament.registeredPlayers);

    process.exit(0);
  } catch (error) {
    console.error('Error testing registration:', error);
    process.exit(1);
  }
}

testTournamentRegistration();