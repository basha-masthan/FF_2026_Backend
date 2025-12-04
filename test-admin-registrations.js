const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Test admin registrations endpoint
async function testAdminRegistrations() {
  try {
    console.log('🧪 Testing admin registrations endpoint...');

    // Generate admin token
    const adminToken = jwt.sign(
      { username: 'admin', email: 'official4basha@gmail.com', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    console.log('🔑 Admin token generated');

    // Test the endpoint
    const response = await fetch('http://localhost:3000/admin/registrations?page=1&limit=10&sortBy=registrationDate&sortOrder=desc', {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Admin registrations endpoint working!');
      console.log(`📊 Total registrations: ${data.pagination.total}`);
      console.log(`📄 Page: ${data.pagination.page}, Limit: ${data.pagination.limit}`);
      console.log(`🔄 Sort by: ${data.sortBy}, Order: ${data.sortOrder}`);

      if (data.registrations.length > 0) {
        console.log('📋 Sample registration:');
        const sample = data.registrations[0];
        console.log(`   👤 User: ${sample.user.fullname} (${sample.user.email})`);
        console.log(`   🏆 Tournament: ${sample.tournament.tournamentId}`);
        console.log(`   📅 Registration Date: ${new Date(sample.registrationDate).toLocaleString()}`);
        console.log(`   💰 Entry Fee: $${sample.entryFee}`);
        console.log(`   🎮 Free Fire ID: ${sample.freeFireId || 'N/A'}`);
        console.log(`   👥 Team: ${sample.teamSelection || 'N/A'}`);
        console.log(`   ✅ Terms Accepted: ${sample.termsAccepted}`);
      } else {
        console.log('📭 No registrations found');
      }
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Admin registrations endpoint failed:', errorData);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    mongoose.connection.close();
    process.exit(0);
  }
}

// Run the test
testAdminRegistrations();