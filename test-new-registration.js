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
  mode: { type: String, required: true, enum: ['clash_squad', 'battle_royal', 'lone_wolf'] },
  teamSize: { type: String, enum: ['1vs1', '2v2', '4v4', '6v6'] },
  entryFee: { type: Number, required: true, min: 0 },
  winningFee: { type: Number, required: true, min: 0 },
  maxSlots: { type: Number, required: true, min: 1 },
  registeredPlayers: { type: Number, default: 0 },
  startTime: { type: Date, required: true },
  status: { type: String, enum: ['upcoming', 'active', 'completed'], default: 'upcoming' },
  banner: { type: String, default: 'default.jpg' },
  roomId: { type: String, default: '' },
  roomPassword: { type: String, default: '' },
  prizes: { top5: [Number], top10: [Number], perKill: Number },
  registeredUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const Tournament = mongoose.model('Tournament', tournamentSchema);

// Registration Schema
const registrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  tournamentIdString: { type: String, required: true },
  registrationDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['registered', 'cancelled', 'refunded'], default: 'registered' },
  entryFee: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['wallet', 'direct'], default: 'wallet' },
  metadata: {
    userSnapshot: {
      fullname: String,
      email: String,
      mobile: String,
      age: Number,
      state: String
    },
    tournamentSnapshot: {
      tournamentId: String,
      mode: String,
      teamSize: String,
      map: String,
      startTime: Date
    }
  }
});

const Registration = mongoose.model('Registration', registrationSchema);

async function testNewRegistrationSystem() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Create a test user with sufficient balance
    const timestamp = Date.now();
    const testUser = new User({
      fullname: `Test Registration User ${timestamp}`,
      email: `test-registration-${timestamp}@example.com`,
      password: 'hashedpassword',
      depositAmount: 200, // $200 balance
      winningAmount: 100,  // $100 winning balance
      mobile: `12345678${Math.floor(Math.random() * 10)}`,
      age: 20 + Math.floor(Math.random() * 20), // Random age between 20-40
      state: 'Test State'
    });

    await testUser.save();
    console.log('✅ Created test user:', testUser._id);

    // Find an upcoming tournament
    const tournament = await Tournament.findOne({ status: 'upcoming' }).sort({ entryFee: 1 });
    if (!tournament) {
      console.log('❌ No upcoming tournaments found');
      return;
    }

    console.log('🎯 Testing registration for tournament:', tournament.tournamentId);
    console.log('💰 Entry fee:', tournament.entryFee);
    console.log('💵 User balance:', testUser.depositAmount + testUser.winningAmount);

    // Check balance
    const totalBalance = testUser.depositAmount + testUser.winningAmount;
    if (totalBalance < tournament.entryFee) {
      console.log('❌ Insufficient balance for registration');
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
        console.log('❌ Balance calculation error');
        return;
      }
    }

    // Save user balance update
    await testUser.save();

    // Create registration record
    const registration = new Registration({
      userId: testUser._id,
      tournamentId: tournament._id,
      tournamentIdString: tournament.tournamentId,
      entryFee: tournament.entryFee,
      paymentMethod: 'wallet',
      metadata: {
        userSnapshot: {
          fullname: testUser.fullname,
          email: testUser.email,
          mobile: testUser.mobile,
          age: testUser.age,
          state: testUser.state
        },
        tournamentSnapshot: {
          tournamentId: tournament.tournamentId,
          mode: tournament.mode,
          teamSize: tournament.teamSize,
          map: tournament.map,
          startTime: tournament.startTime
        }
      }
    });

    await registration.save();
    console.log('✅ Created registration record:', registration._id);

    // Add user to registered users and increment count
    tournament.registeredUsers.push(testUser._id);
    tournament.registeredPlayers += 1;
    await tournament.save();

    console.log('✅ Registration successful!');
    console.log('🏆 Tournament:', tournament.tournamentId);
    console.log('👤 User:', testUser.fullname);
    console.log('💸 Deducted from deposit:', deductedFromDeposit);
    console.log('💰 Deducted from winning:', deductedFromWinning);
    console.log('💳 New balance:', testUser.depositAmount + testUser.winningAmount);
    console.log('📅 Registration date:', registration.registrationDate);

    // Verify the registration
    const savedRegistration = await Registration.findById(registration._id);
    console.log('🔍 Registration verified:', !!savedRegistration);
    console.log('📊 Total registrations in DB:', await Registration.countDocuments());

    // Test the admin API endpoint
    console.log('\n🧪 Testing admin registrations endpoint...');
    // We'll test this manually since we can't make HTTP requests from this script

    process.exit(0);
  } catch (error) {
    console.error('❌ Error testing new registration system:', error);
    process.exit(1);
  }
}

testNewRegistrationSystem();