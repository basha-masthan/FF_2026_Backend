const mongoose = require('mongoose');
require('dotenv').config();

// Registration Schema (same as in server.js)
const registrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  tournamentIdString: { type: String, required: true },
  registrationDate: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['registered', 'cancelled', 'refunded'],
    default: 'registered'
  },
  entryFee: { type: Number, required: true },
  paymentMethod: {
    type: String,
    enum: ['wallet', 'direct'],
    default: 'wallet'
  },
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

async function testAdminRegistrations() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Count total registrations
    const totalRegistrations = await Registration.countDocuments();
    console.log('Total registrations in database:', totalRegistrations);

    if (totalRegistrations > 0) {
      // Get sample registrations (without populate to avoid schema issues)
      const registrations = await Registration.find()
        .limit(5)
        .sort({ registrationDate: -1 });

      console.log('\nSample registrations:');
      registrations.forEach((reg, index) => {
        console.log(`${index + 1}. ${reg.metadata.userSnapshot.fullname} registered for ${reg.tournamentIdString} on ${reg.registrationDate}`);
      });

      // Test sorting by different criteria
      console.log('\nTesting sorting by participant name:');
      const sortedByName = await Registration.find()
        .sort({ 'metadata.userSnapshot.fullname': 1 })
        .limit(3);
      sortedByName.forEach(reg => {
        console.log(`- ${reg.metadata.userSnapshot.fullname}`);
      });

      console.log('\nTesting sorting by tournament ID:');
      const sortedByTournament = await Registration.find()
        .sort({ tournamentIdString: 1 })
        .limit(3);
      sortedByTournament.forEach(reg => {
        console.log(`- ${reg.tournamentIdString}: ${reg.metadata.userSnapshot.fullname}`);
      });

    } else {
      console.log('No registrations found. The new registration system may not be active yet.');
      console.log('Try registering for a tournament through the frontend to test the new system.');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error testing admin registrations:', error);
    process.exit(1);
  }
}

testAdminRegistrations();