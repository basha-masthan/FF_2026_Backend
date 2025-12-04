const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (images)
app.use('/img', express.static('img'));

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Razorpay configuration
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Temporary OTP storage (in production, use Redis or database)
const otpStorage = new Map();

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

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
    enum: ['clash_squad', 'battle_royal', 'lone_wolf'],
    validate: {
      validator: function(value) {
        // For battle_royal, maxSlots must be exactly 48
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
        // Battle Royal must have exactly 48 slots
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
  banner: { type: String, default: 'default.jpg' }, // Banner image filename
  roomId: { type: String, default: '' }, // Room ID for the tournament
  roomPassword: { type: String, default: '' }, // Room password for the tournament
  customUrl: { type: String, default: '' }, // Custom lobby URL for the tournament
  roomNotes: { type: String, default: '' }, // Additional room notes/instructions
  prizes: {
    top5: [Number], // Array of prizes for top 5
    top10: [Number], // Array of prizes for positions 6-10
    perKill: Number // Prize per kill
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
  reference: { type: String, required: true }, // Unique reference to prevent duplicates
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
    razorpayPaymentId: String
  },
  createdAt: { type: Date, default: Date.now }
});

// Compound index to prevent duplicate transactions
transactionSchema.index({ userId: 1, reference: 1, referenceType: 1 }, { unique: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// Tournament Registration Schema
const registrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  tournamentIdString: { type: String, required: true }, // For easier querying
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
  // New fields for enhanced registration
  freeFireId: { type: String, required: true },
  termsAccepted: { type: Boolean, required: true, default: false },
  teamSelection: {
    type: String,
    enum: ['team_a', 'team_b', null],
    default: null,
    validate: {
      validator: function(value) {
        // Only require team selection for duo/squad tournaments
        if (this.metadata?.tournamentSnapshot?.teamSize && ['2v2', '4v4', '6v6'].includes(this.metadata.tournamentSnapshot.teamSize)) {
          return value !== null;
        }
        return true;
      },
      message: 'Team selection is required for duo and squad tournaments'
    }
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

// Compound index to prevent duplicate registrations
registrationSchema.index({ userId: 1, tournamentId: 1 }, { unique: true });

// Index to prevent duplicate Free Fire IDs within same tournament
registrationSchema.index({ tournamentId: 1, freeFireId: 1 }, { unique: true });

// Index for efficient sorting and querying
registrationSchema.index({ registrationDate: -1 });
registrationSchema.index({ 'metadata.userSnapshot.fullname': 1 });
registrationSchema.index({ tournamentIdString: 1 });

const Registration = mongoose.model('Registration', registrationSchema);

// Generate 5-digit OTP
function generateOTP() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// Routes
app.post('/signup', async (req, res) => {
  try {
    const { fullname, email, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Generate OTP
    const otp = generateOTP();

    // Store OTP temporarily
    otpStorage.set(email, { otp, userData: { fullname, email, password }, timestamp: Date.now() });

    // Send OTP email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your OTP for Signup Verification',
      text: `Your OTP is: ${otp}. It will expire in 10 minutes.`
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'OTP sent to your email. Please verify to complete signup.' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    const storedData = otpStorage.get(email);
    if (!storedData) {
      return res.status(400).json({ message: 'OTP not found or expired' });
    }

    // Check if OTP is expired (10 minutes)
    if (Date.now() - storedData.timestamp > 10 * 60 * 1000) {
      otpStorage.delete(email);
      return res.status(400).json({ message: 'OTP expired' });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // OTP verified, hash password and save user
    const { fullname, email: userEmail, password } = storedData.userData;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ fullname, email: userEmail, password: hashedPassword });
    await newUser.save();

    // Remove OTP from storage
    otpStorage.delete(email);

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    if (error.code === 11000) {
      res.status(400).json({ message: 'Email already exists' });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

// Login route
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        fullname: user.fullname,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Token verification route
app.get('/verify-token', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Protected route example (can be used for any protected content)
app.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'This is protected content', user: req.user });
});

// Forgot password route
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'No account found with this email address' });
    }

    // Generate reset token (in production, use a proper reset token system)
    const resetToken = jwt.sign(
      { userId: user._id, email: user.email, type: 'password_reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Send reset email
    const resetLink = `http://localhost:3000/reset-password?token=${resetToken}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Password Reset Request',
      html: `
        <h2>Password Reset Request</h2>
        <p>You requested a password reset for your Future Bound account.</p>
        <p>Click the link below to reset your password:</p>
        <a href="${resetLink}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'Password reset link sent to your email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin authentication routes
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check admin credentials
    if (username !== 'admin' || password !== 'admin') {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    // Generate OTP for admin email
    const otp = generateOTP();

    // Store admin OTP temporarily (different from user OTP)
    otpStorage.set('admin_official4basha@gmail.com', {
      otp,
      userData: { username: 'admin', email: 'official4basha@gmail.com' },
      timestamp: Date.now(),
      type: 'admin'
    });

    // Send OTP to admin email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'official4basha@gmail.com',
      subject: 'Admin Login OTP Verification',
      text: `Your admin login OTP is: ${otp}. This OTP will expire in 10 minutes.`
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'OTP sent to admin email. Please verify to continue.' });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin OTP verification
app.post('/admin/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    const adminKey = 'admin_official4basha@gmail.com';

    const storedData = otpStorage.get(adminKey);
    if (!storedData || storedData.type !== 'admin') {
      return res.status(400).json({ message: 'OTP not found or expired' });
    }

    // Check if OTP is expired (10 minutes)
    if (Date.now() - storedData.timestamp > 10 * 60 * 1000) {
      otpStorage.delete(adminKey);
      return res.status(400).json({ message: 'OTP expired' });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // OTP verified, generate admin JWT token
    const token = jwt.sign(
      { username: 'admin', email: 'official4basha@gmail.com', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' } // Admin sessions last longer
    );

    // Remove OTP from storage
    otpStorage.delete(adminKey);

    res.json({
      message: 'Admin login successful',
      token,
      admin: {
        username: 'admin',
        email: 'official4basha@gmail.com',
        role: 'admin'
      }
    });
  } catch (error) {
    console.error('Admin OTP verification error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin token verification
app.get('/admin/verify-token', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  res.json({ valid: true, admin: req.user });
});

// Resend admin OTP
app.post('/admin/resend-otp', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username !== 'admin' || password !== 'admin') {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    const adminKey = 'admin_official4basha@gmail.com';
    const otp = generateOTP();

    otpStorage.set(adminKey, {
      otp,
      userData: { username: 'admin', email: 'official4basha@gmail.com' },
      timestamp: Date.now(),
      type: 'admin'
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'official4basha@gmail.com',
      subject: 'Admin Login OTP Verification (Resent)',
      text: `Your admin login OTP is: ${otp}. This OTP will expire in 10 minutes.`
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'OTP resent to admin email.' });
  } catch (error) {
    console.error('Admin resend OTP error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin dashboard stats
app.get('/admin/dashboard-stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    // Get user statistics
    const totalUsers = await User.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySignups = await User.countDocuments({ createdAt: { $gte: today } });

    // Mock data for other stats (in a real app, you'd track these)
    const pendingVerifications = otpStorage.size; // Rough estimate
    const activeSessions = 1; // Would need session tracking

    res.json({
      totalUsers,
      pendingVerifications,
      activeSessions,
      todaySignups
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin user management
app.get('/admin/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { search } = req.query;
    let query = {};

    if (search) {
      query = {
        $or: [
          { email: { $regex: search, $options: 'i' } },
          { fullname: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const users = await User.find(query)
      .select('fullname email createdAt')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(users);
  } catch (error) {
    console.error('User management error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Tournament management endpoints
app.post('/admin/tournaments', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const tournamentData = req.body;

    // Sanitize and convert data types
    const sanitizedData = {
      tournamentId: tournamentData.tournamentId,
      map: tournamentData.map,
      mode: tournamentData.mode,
      teamSize: tournamentData.teamSize || undefined, // Only set if provided
      entryFee: parseFloat(tournamentData.entryFee) || 0,
      winningFee: parseFloat(tournamentData.winningFee) || 0,
      maxSlots: parseInt(tournamentData.maxSlots) || 1,
      startTime: new Date(tournamentData.startTime),
      status: tournamentData.status || 'upcoming',
      banner: tournamentData.banner && tournamentData.banner.trim() !== '' ? tournamentData.banner.trim() : 'default.jpg',
      roomId: tournamentData.roomId || '',
      roomPassword: tournamentData.roomPassword || '',
      prizes: {
        top5: Array.isArray(tournamentData.prizes?.top5) ? tournamentData.prizes.top5.map(Number) : [],
        top10: Array.isArray(tournamentData.prizes?.top10) ? tournamentData.prizes.top10.map(Number) : [],
        perKill: parseFloat(tournamentData.prizes?.perKill) || 0
      }
    };

    // Validate required fields
    if (!sanitizedData.tournamentId || !sanitizedData.map || !sanitizedData.mode) {
      return res.status(400).json({ message: 'Missing required fields: tournamentId, map, mode' });
    }

    // Validate startTime
    if (isNaN(sanitizedData.startTime.getTime())) {
      return res.status(400).json({ message: 'Invalid startTime format' });
    }

    const tournament = new Tournament(sanitizedData);
    await tournament.save();

    res.status(201).json({ message: 'Tournament created successfully', tournament });
  } catch (error) {
    console.error('Tournament creation error:', error);
    if (error.code === 11000) {
      res.status(400).json({ message: 'Tournament ID already exists' });
    } else if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ message: 'Validation error', errors });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

app.get('/admin/tournaments', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const tournaments = await Tournament.find()
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(tournaments);
  } catch (error) {
    console.error('Tournament fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/admin/tournaments/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    await Tournament.findByIdAndDelete(req.params.id);
    res.json({ message: 'Tournament deleted successfully' });
  } catch (error) {
    console.error('Tournament deletion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get available banner images
app.get('/banners', (req, res) => {
  const fs = require('fs');
  const path = require('path');

  try {
    const imgDir = path.join(__dirname, 'img');
    const files = fs.readdirSync(imgDir);
    const imageFiles = files.filter(file =>
      /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
    );

    res.json(imageFiles);
  } catch (error) {
    console.error('Error reading banner images:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Public tournament endpoints for users
app.get('/tournaments', async (req, res) => {
  try {
    const tournaments = await Tournament.find({ status: { $in: ['upcoming', 'active'] } })
      .sort({ startTime: 1 })
      .limit(20);

    res.json(tournaments);
  } catch (error) {
    console.error('Tournament fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/tournaments/:id/register', authenticateToken, async (req, res) => {
  try {
    const { freeFireId, termsAccepted, teamSelection } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    if (tournament.status !== 'upcoming') {
      return res.status(400).json({ message: 'Tournament registration is closed' });
    }

    if (tournament.registeredPlayers >= tournament.maxSlots) {
      return res.status(400).json({ message: 'Tournament is full' });
    }

    if (tournament.registeredUsers.includes(req.user.userId)) {
      return res.status(400).json({ message: 'Already registered for this tournament' });
    }

    // Validate required fields
    if (!freeFireId || !freeFireId.trim()) {
      return res.status(400).json({ message: 'Free Fire ID is required' });
    }

    if (!termsAccepted) {
      return res.status(400).json({ message: 'You must accept the terms and conditions' });
    }

    // Validate Free Fire ID format (numeric only)
    if (!/^\d+$/.test(freeFireId.trim())) {
      return res.status(400).json({ message: 'Free Fire ID must contain only numbers' });
    }

    // Validate team selection for duo/squad tournaments
    const requiresTeamSelection = ['2v2', '4v4', '6v6'].includes(tournament.teamSize);
    if (requiresTeamSelection && (!teamSelection || !['team_a', 'team_b'].includes(teamSelection))) {
      return res.status(400).json({ message: 'Valid team selection is required for this tournament type' });
    }

    // Get user and check balance
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const totalBalance = user.depositAmount + user.winningAmount;
    if (totalBalance < tournament.entryFee) {
      return res.status(400).json({
        message: `Insufficient balance. You need $${tournament.entryFee} but only have $${totalBalance.toFixed(2)}`
      });
    }

    // Deduct from accounts: deposit first, then winning
    let remainingFee = tournament.entryFee;
    let deductedFromDeposit = 0;
    let deductedFromWinning = 0;

    // First deduct from deposit account
    if (user.depositAmount >= remainingFee) {
      deductedFromDeposit = remainingFee;
      user.depositAmount -= remainingFee;
      remainingFee = 0;
    } else {
      deductedFromDeposit = user.depositAmount;
      remainingFee -= user.depositAmount;
      user.depositAmount = 0;
    }

    // Then deduct from winning account if needed
    if (remainingFee > 0) {
      if (user.winningAmount >= remainingFee) {
        deductedFromWinning = remainingFee;
        user.winningAmount -= remainingFee;
        remainingFee = 0;
      } else {
        // This shouldn't happen since we checked total balance above
        return res.status(400).json({ message: 'Balance calculation error' });
      }
    }

    // Save user balance update
    await user.save();

    // Log the entry fee transaction
    try {
      await logTransaction(
        req.user.userId,
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
      // Don't fail registration if transaction logging fails
    }

    // Create registration record
    const registration = new Registration({
      userId: req.user.userId,
      tournamentId: tournament._id,
      tournamentIdString: tournament.tournamentId,
      freeFireId: freeFireId.trim(),
      termsAccepted: true,
      teamSelection: requiresTeamSelection ? teamSelection : null,
      entryFee: tournament.entryFee,
      paymentMethod: 'wallet',
      metadata: {
        userSnapshot: {
          fullname: user.fullname,
          email: user.email,
          mobile: user.mobile,
          age: user.age,
          state: user.state
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

    // Add user to registered users and increment count
    tournament.registeredUsers.push(req.user.userId);
    tournament.registeredPlayers += 1;
    await tournament.save();

    res.json({
      message: 'Successfully registered for tournament',
      deductedFromDeposit: deductedFromDeposit,
      deductedFromWinning: deductedFromWinning,
      newBalance: user.depositAmount + user.winningAmount,
      registrationId: registration._id,
      teamAssigned: requiresTeamSelection ? teamSelection : null
    });
  } catch (error) {
    console.error('Tournament registration error:', error);
    if (error.code === 11000) {
      res.status(400).json({ message: 'You are already registered for this tournament' });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

app.get('/my-tournaments', authenticateToken, async (req, res) => {
  try {
    const tournaments = await Tournament.find({
      registeredUsers: req.user.userId,
      status: { $in: ['upcoming', 'active'] }
    }).sort({ startTime: 1 });

    res.json(tournaments);
  } catch (error) {
    console.error('My tournaments fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user profile
app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user profile
app.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullname, mobile, age, state, currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // If updating password, verify current password
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Current password is required to change password' });
      }

      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }

      user.password = await bcrypt.hash(newPassword, 10);
    }

    // Update other fields
    if (fullname) user.fullname = fullname;
    if (mobile !== undefined) user.mobile = mobile;
    if (age !== undefined) user.age = age;
    if (state !== undefined) user.state = state;

    await user.save();

    // Return updated user data (excluding password)
    const updatedUser = await User.findById(userId).select('-password');
    res.json({
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get Razorpay key for frontend
app.get('/get-razorpay-key', (req, res) => {
  res.json({ key: process.env.RAZORPAY_KEY_ID });
});

// Test endpoint to check environment variables
app.get('/test-env', (req, res) => {
  res.json({
    razorpay_key_id: process.env.RAZORPAY_KEY_ID ? 'Present' : 'Missing',
    razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET ? 'Present' : 'Missing',
    mongodb_uri: process.env.MONGODB_URI ? 'Present' : 'Missing',
    jwt_secret: process.env.JWT_SECRET ? 'Present' : 'Missing'
  });
});

// Payment endpoints
app.post('/create-payment-order', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 10 || amount > 10000) {
      return res.status(400).json({ message: 'Invalid amount. Must be between ₹10 and ₹10,000' });
    }

    // Check if Razorpay is configured
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ message: 'Payment service not configured' });
    }

    // Create Razorpay order
    const options = {
      amount: amount * 100, // Razorpay expects amount in paisa
      currency: 'INR',
      receipt: `rcpt_${Date.now().toString().slice(-6)}_${req.user.userId.slice(-4)}`,
      payment_capture: 1 // Auto capture
    };

    const order = await razorpay.orders.create(options);

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt
    });

  } catch (error) {
    console.error('Payment order creation error:', error);
    res.status(500).json({ message: 'Failed to create payment order' });
  }
});

app.post('/verify-payment', authenticateToken, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      receipt
    } = req.body;

    // Verify payment signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    if (razorpay_signature !== expectedSign) {
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    // Extract amount from receipt (format: rcpt_timestamp_userId)
    const receiptParts = receipt.split('_');
    if (receiptParts.length !== 3) {
      return res.status(400).json({ message: 'Invalid receipt format' });
    }

    // Get payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const amount = payment.amount / 100; // Convert from paisa to rupees

    // Update user balance
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.depositAmount += amount;
    await user.save();

    // Log the deposit transaction
    try {
      await logTransaction(
        req.user.userId,
        'deposit',
        amount,
        `Wallet deposit via Razorpay`,
        razorpay_payment_id,
        'payment_id',
        {
          paymentId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id
        }
      );
    } catch (transactionError) {
      console.error('Error logging deposit transaction:', transactionError);
      // Don't fail the payment if transaction logging fails
    }

    res.json({
      message: 'Payment verified and wallet updated successfully',
      amount: amount,
      newBalance: user.depositAmount + user.winningAmount
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ message: 'Payment verification failed' });
  }
});

// Transaction logging functions
async function logTransaction(userId, type, amount, description, reference, referenceType, metadata = {}) {
  try {
    // Check if transaction already exists to prevent duplicates
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

// Get user transactions
app.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find({ userId: req.user.userId })
      .populate('metadata.tournamentId', 'tournamentId mode')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments({ userId: req.user.userId });

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin endpoint to get all transactions (for monitoring)
app.get('/admin/transactions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { page = 1, limit = 50, userId, type } = req.query;
    const skip = (page - 1) * limit;

    let query = {};
    if (userId) query.userId = userId;
    if (type) query.type = type;

    const transactions = await Transaction.find(query)
      .populate('userId', 'fullname email')
      .populate('metadata.tournamentId', 'tournamentId mode')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching admin transactions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Manual transaction logging (admin only)
app.post('/admin/transactions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { userId, type, amount, description, reference, referenceType, metadata } = req.body;

    // Validate required fields
    if (!userId || !type || !amount || !description || !reference || !referenceType) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Validate transaction type
    const validTypes = ['deposit', 'winning', 'entry_fee', 'withdrawal'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid transaction type' });
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update user balance based on transaction type
    if (type === 'deposit') {
      user.depositAmount += amount;
    } else if (type === 'winning') {
      user.winningAmount += amount;
    } else if (type === 'entry_fee' || type === 'withdrawal') {
      // Deduct from available balance
      const totalBalance = user.depositAmount + user.winningAmount;
      if (totalBalance < Math.abs(amount)) {
        return res.status(400).json({ message: 'Insufficient balance' });
      }

      // Deduct from deposit first, then winning
      let remainingAmount = Math.abs(amount);
      if (user.depositAmount >= remainingAmount) {
        user.depositAmount -= remainingAmount;
      } else {
        remainingAmount -= user.depositAmount;
        user.depositAmount = 0;
        user.winningAmount -= remainingAmount;
      }
    }

    await user.save();

    // Log the transaction
    const transaction = await logTransaction(
      userId,
      type,
      type === 'entry_fee' || type === 'withdrawal' ? -Math.abs(amount) : amount,
      description,
      reference,
      referenceType,
      metadata
    );

    res.status(201).json({
      message: 'Transaction logged successfully',
      transaction,
      newBalance: user.depositAmount + user.winningAmount
    });
  } catch (error) {
    console.error('Error logging manual transaction:', error);
    if (error.code === 11000) {
      res.status(400).json({ message: 'Transaction with this reference already exists' });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

// Award tournament winnings (admin/system endpoint)
app.post('/admin/award-winnings', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId, winners } = req.body;

    // Validate input
    if (!tournamentId || !winners || !Array.isArray(winners)) {
      return res.status(400).json({ message: 'Invalid request data' });
    }

    // Find tournament
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    if (tournament.status !== 'completed') {
      return res.status(400).json({ message: 'Tournament is not completed' });
    }

    const results = [];

    // Process each winner
    for (const winner of winners) {
      const { userId, amount, position } = winner;

      // Find user
      const user = await User.findById(userId);
      if (!user) {
        results.push({ userId, success: false, error: 'User not found' });
        continue;
      }

      // Update user winning amount
      user.winningAmount += amount;
      await user.save();

      // Log the winning transaction
      try {
        await logTransaction(
          userId,
          'winning',
          amount,
          `Tournament winnings - ${tournament.tournamentId} (Position ${position})`,
          `${tournamentId}_${userId}_${position}`,
          'tournament_id',
          {
            tournamentId: tournament._id,
            position: position
          }
        );

        results.push({
          userId,
          success: true,
          amount,
          newWinningBalance: user.winningAmount,
          newTotalBalance: user.depositAmount + user.winningAmount
        });
      } catch (transactionError) {
        console.error('Error logging winning transaction:', transactionError);
        results.push({ userId, success: false, error: 'Failed to log transaction' });
      }
    }

    res.json({
      message: 'Winnings processed',
      tournamentId,
      results
    });
  } catch (error) {
    console.error('Error awarding winnings:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get transaction statistics (admin)
app.get('/admin/transaction-stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const stats = await Transaction.aggregate([
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);

    const totalTransactions = await Transaction.countDocuments();
    const todayTransactions = await Transaction.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    res.json({
      totalTransactions,
      todayTransactions,
      typeBreakdown: stats
    });
  } catch (error) {
    console.error('Error fetching transaction stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Tournament Registration Management Endpoints

// Get registered users for a specific tournament (Admin only)
app.get('/admin/tournaments/:tournamentId/registrations', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId } = req.params;
    const { page = 1, limit = 20, search } = req.query;

    // Validate tournament exists - support both MongoDB ObjectId and tournamentId string
    let tournament;
    if (mongoose.Types.ObjectId.isValid(tournamentId)) {
      tournament = await Tournament.findById(tournamentId);
    } else {
      tournament = await Tournament.findOne({ tournamentId: tournamentId });
    }

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const skip = (page - 1) * limit;
    let query = { _id: { $in: tournament.registeredUsers } };

    // Add search functionality
    if (search) {
      query = {
        $and: [
          { _id: { $in: tournament.registeredUsers } },
          {
            $or: [
              { fullname: { $regex: search, $options: 'i' } },
              { email: { $regex: search, $options: 'i' } }
            ]
          }
        ]
      };
    }

    // Get registered users with pagination
    const users = await User.find(query)
      .select('fullname email mobile age state winningAmount depositAmount createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    // Get registration details for each user
    const usersWithRegistrationDetails = await Promise.all(users.map(async (user) => {
      const registration = await Registration.findOne({
        userId: user._id,
        tournamentId: tournament._id
      });

      return {
        _id: user._id,
        fullname: user.fullname,
        email: user.email,
        mobile: user.mobile || '',
        age: user.age || null,
        state: user.state || '',
        totalBalance: (user.winningAmount || 0) + (user.depositAmount || 0),
        winningAmount: user.winningAmount || 0,
        depositAmount: user.depositAmount || 0,
        registrationTime: registration ? registration.registrationDate : user.createdAt,
        status: 'registered',
        freeFireId: registration ? registration.freeFireId : '',
        termsAccepted: registration ? registration.termsAccepted : false,
        teamSelection: registration ? registration.teamSelection : null
      };
    }));

    res.json({
      tournament: {
        _id: tournament._id,
        tournamentId: tournament.tournamentId,
        mode: tournament.mode,
        teamSize: tournament.teamSize,
        maxSlots: tournament.maxSlots,
        registeredPlayers: tournament.registeredPlayers,
        status: tournament.status,
        startTime: tournament.startTime,
        roomId: tournament.roomId,
        roomPassword: tournament.roomPassword,
        prizes: tournament.prizes
      },
      registrations: usersWithRegistrationDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching tournament registrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update tournament room details, URLs, and additional info (Admin only)
app.put('/admin/tournaments/:tournamentId/room-details', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId } = req.params;
    const { roomId, roomPassword, customUrl, roomNotes } = req.body;

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    // Validate input
    if (roomId !== undefined) {
      if (typeof roomId !== 'string' || roomId.trim().length === 0) {
        return res.status(400).json({ message: 'Room ID must be a non-empty string' });
      }
      tournament.roomId = roomId.trim();
    }

    if (roomPassword !== undefined) {
      if (typeof roomPassword !== 'string' || roomPassword.trim().length === 0) {
        return res.status(400).json({ message: 'Room password must be a non-empty string' });
      }
      tournament.roomPassword = roomPassword.trim();
    }

    // Add custom URL field if not exists
    if (customUrl !== undefined) {
      if (customUrl && (typeof customUrl !== 'string' || !customUrl.match(/^https?:\/\/.+/))) {
        return res.status(400).json({ message: 'Custom URL must be a valid HTTP/HTTPS URL' });
      }
      tournament.customUrl = customUrl || '';
    }

    // Add room notes field if not exists
    if (roomNotes !== undefined) {
      tournament.roomNotes = roomNotes || '';
    }

    await tournament.save();

    res.json({
      message: 'Tournament room details updated successfully',
      tournament: {
        _id: tournament._id,
        tournamentId: tournament.tournamentId,
        roomId: tournament.roomId,
        roomPassword: tournament.roomPassword,
        customUrl: tournament.customUrl,
        roomNotes: tournament.roomNotes
      }
    });

  } catch (error) {
    console.error('Error updating tournament room details:', error);
    if (error.name === 'ValidationError') {
      res.status(400).json({ message: 'Validation error', errors: error.errors });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

// Update tournament room details and prizes (Admin only)
app.put('/admin/tournaments/:tournamentId/details', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId } = req.params;
    const { roomId, roomPassword, prizes } = req.body;

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    // Validate input
    if (roomId !== undefined) {
      if (typeof roomId !== 'string' || roomId.trim().length === 0) {
        return res.status(400).json({ message: 'Room ID must be a non-empty string' });
      }
      tournament.roomId = roomId.trim();
    }

    if (roomPassword !== undefined) {
      if (typeof roomPassword !== 'string' || roomPassword.trim().length === 0) {
        return res.status(400).json({ message: 'Room password must be a non-empty string' });
      }
      tournament.roomPassword = roomPassword.trim();
    }

    if (prizes !== undefined) {
      // Validate prizes structure
      if (typeof prizes !== 'object') {
        return res.status(400).json({ message: 'Prizes must be an object' });
      }

      if (prizes.top5 && !Array.isArray(prizes.top5)) {
        return res.status(400).json({ message: 'top5 prizes must be an array' });
      }

      if (prizes.top10 && !Array.isArray(prizes.top10)) {
        return res.status(400).json({ message: 'top10 prizes must be an array' });
      }

      if (prizes.perKill !== undefined && (typeof prizes.perKill !== 'number' || prizes.perKill < 0)) {
        return res.status(400).json({ message: 'perKill must be a non-negative number' });
      }

      tournament.prizes = {
        top5: prizes.top5 || tournament.prizes?.top5 || [],
        top10: prizes.top10 || tournament.prizes?.top10 || [],
        perKill: prizes.perKill !== undefined ? prizes.perKill : tournament.prizes?.perKill || 0
      };
    }

    await tournament.save();

    res.json({
      message: 'Tournament details updated successfully',
      tournament: {
        _id: tournament._id,
        tournamentId: tournament.tournamentId,
        roomId: tournament.roomId,
        roomPassword: tournament.roomPassword,
        prizes: tournament.prizes
      }
    });

  } catch (error) {
    console.error('Error updating tournament details:', error);
    if (error.name === 'ValidationError') {
      res.status(400).json({ message: 'Validation error', errors: error.errors });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

// Get tournament statistics (Admin only)
app.get('/admin/tournaments/:tournamentId/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    // Get registration statistics
    const totalRegistrations = tournament.registeredPlayers;
    const availableSlots = tournament.maxSlots - totalRegistrations;

    // Get balance statistics for registered users
    const registeredUsers = await User.find({ _id: { $in: tournament.registeredUsers } })
      .select('winningAmount depositAmount');

    let totalDepositBalance = 0;
    let totalWinningBalance = 0;
    let totalCombinedBalance = 0;

    registeredUsers.forEach(user => {
      const deposit = user.depositAmount || 0;
      const winning = user.winningAmount || 0;
      totalDepositBalance += deposit;
      totalWinningBalance += winning;
      totalCombinedBalance += deposit + winning;
    });

    // Calculate expected revenue
    const expectedRevenue = totalRegistrations * tournament.entryFee;

    res.json({
      tournamentId: tournament.tournamentId,
      mode: tournament.mode,
      status: tournament.status,
      registrationStats: {
        totalRegistrations,
        availableSlots,
        maxSlots: tournament.maxSlots,
        registrationRate: ((totalRegistrations / tournament.maxSlots) * 100).toFixed(1)
      },
      balanceStats: {
        totalDepositBalance: totalDepositBalance.toFixed(2),
        totalWinningBalance: totalWinningBalance.toFixed(2),
        totalCombinedBalance: totalCombinedBalance.toFixed(2),
        averageBalance: totalRegistrations > 0 ? (totalCombinedBalance / totalRegistrations).toFixed(2) : 0
      },
      revenueStats: {
        entryFee: tournament.entryFee,
        expectedRevenue: expectedRevenue.toFixed(2),
        collectedRevenue: expectedRevenue.toFixed(2) // Assuming all payments are collected
      },
      roomDetails: {
        roomId: tournament.roomId || null,
        hasRoomPassword: !!tournament.roomPassword,
        prizesConfigured: !!(tournament.prizes?.top5?.length || tournament.prizes?.top10?.length || tournament.prizes?.perKill)
      }
    });

  } catch (error) {
    console.error('Error fetching tournament stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk update tournament prizes (Admin only)
app.put('/admin/tournaments/:tournamentId/prizes', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { tournamentId } = req.params;
    const { top5, top10, perKill } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    // Validate prize arrays
    if (top5 && !Array.isArray(top5)) {
      return res.status(400).json({ message: 'top5 must be an array of numbers' });
    }

    if (top10 && !Array.isArray(top10)) {
      return res.status(400).json({ message: 'top10 must be an array of numbers' });
    }

    // Validate all prize values are numbers >= 0
    const validatePrizes = (prizes, fieldName) => {
      for (let i = 0; i < prizes.length; i++) {
        if (typeof prizes[i] !== 'number' || prizes[i] < 0) {
          throw new Error(`${fieldName}[${i}] must be a non-negative number`);
        }
      }
    };

    if (top5) validatePrizes(top5, 'top5');
    if (top10) validatePrizes(top10, 'top10');

    if (perKill !== undefined && (typeof perKill !== 'number' || perKill < 0)) {
      return res.status(400).json({ message: 'perKill must be a non-negative number' });
    }

    // Update prizes
    tournament.prizes = {
      top5: top5 || tournament.prizes?.top5 || [],
      top10: top10 || tournament.prizes?.top10 || [],
      perKill: perKill !== undefined ? perKill : tournament.prizes?.perKill || 0
    };

    await tournament.save();

    res.json({
      message: 'Tournament prizes updated successfully',
      prizes: tournament.prizes
    });

  } catch (error) {
    console.error('Error updating tournament prizes:', error);
    if (error.message.includes('must be')) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
});

// Get all tournament registrations (Admin only) - Global view
app.get('/admin/registrations', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const {
      page = 1,
      limit = 50,
      sortBy = 'registrationDate',
      sortOrder = 'desc',
      search,
      tournamentId,
      status = 'registered'
    } = req.query;

    const skip = (page - 1) * limit;

    // Build query
    let query = { status: status };

    if (search) {
      query.$or = [
        { 'metadata.userSnapshot.fullname': { $regex: search, $options: 'i' } },
        { 'metadata.userSnapshot.email': { $regex: search, $options: 'i' } },
        { tournamentIdString: { $regex: search, $options: 'i' } }
      ];
    }

    if (tournamentId) {
      query.tournamentIdString = { $regex: tournamentId, $options: 'i' };
    }

    // Build sort object
    const sortOptions = {};
    const validSortFields = ['registrationDate', 'metadata.userSnapshot.fullname', 'tournamentIdString', 'entryFee'];
    if (validSortFields.includes(sortBy)) {
      sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sortOptions.registrationDate = -1; // Default sort
    }

    // Get registrations with pagination
    const registrations = await Registration.find(query)
      .populate('userId', 'fullname email')
      .populate('tournamentId', 'tournamentId mode map startTime status')
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Registration.countDocuments(query);

    // Format response
    const formattedRegistrations = registrations.map(reg => ({
      _id: reg._id,
      user: {
        _id: reg.userId._id,
        fullname: reg.metadata.userSnapshot.fullname,
        email: reg.metadata.userSnapshot.email,
        mobile: reg.metadata.userSnapshot.mobile || '',
        age: reg.metadata.userSnapshot.age || null,
        state: reg.metadata.userSnapshot.state || ''
      },
      tournament: {
        _id: reg.tournamentId._id,
        tournamentId: reg.tournamentIdString,
        mode: reg.metadata.tournamentSnapshot.mode,
        teamSize: reg.metadata.tournamentSnapshot.teamSize,
        map: reg.metadata.tournamentSnapshot.map,
        startTime: reg.metadata.tournamentSnapshot.startTime,
        status: reg.tournamentId.status
      },
      registrationDate: reg.registrationDate,
      entryFee: reg.entryFee,
      status: reg.status,
      paymentMethod: reg.paymentMethod,
      freeFireId: reg.freeFireId,
      termsAccepted: reg.termsAccepted,
      teamSelection: reg.teamSelection
    }));

    res.json({
      registrations: formattedRegistrations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      },
      sortBy,
      sortOrder
    });

  } catch (error) {
    console.error('Error fetching all registrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user registration details for a specific tournament
app.get('/user/registration/:tournamentId', authenticateToken, async (req, res) => {
  try {
    const registration = await Registration.findOne({
      userId: req.user.userId,
      tournamentId: req.params.tournamentId
    });

    if (!registration) {
      return res.status(404).json({ message: 'Registration not found' });
    }

    res.json({
      _id: registration._id,
      freeFireId: registration.freeFireId,
      teamSelection: registration.teamSelection,
      registrationDate: registration.registrationDate,
      status: registration.status,
      entryFee: registration.entryFee
    });
  } catch (error) {
    console.error('Error fetching user registration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get tournament room details (for registered users)
app.get('/tournaments/:tournamentId/room', authenticateToken, async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    // Check if user is registered
    if (!tournament.registeredUsers.includes(req.user.userId)) {
      return res.status(403).json({ message: 'You are not registered for this tournament' });
    }

    // Only show room details if tournament is active or completed
    if (!['active', 'completed'].includes(tournament.status)) {
      return res.status(400).json({ message: 'Room details are not available yet' });
    }

    res.json({
      tournamentId: tournament.tournamentId,
      roomId: tournament.roomId,
      roomPassword: tournament.roomPassword,
      prizes: tournament.prizes,
      status: tournament.status,
      startTime: tournament.startTime
    });

  } catch (error) {
    console.error('Error fetching room details:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});