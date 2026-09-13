const bcrypt = require('bcryptjs');
const { mongoose, connectDatabase } = require('./db');

async function checkMaster() {
  const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.MASTER_PASSWORD || '');

  console.log('');
  console.log('Checking SuperWallet master account...');
  console.log('Email:', email);
  console.log('Password from .env loaded:', password ? 'YES' : 'NO');

  await connectDatabase();

  const User = mongoose.models.User || mongoose.model(
    'User',
    new mongoose.Schema(
      {
        username: String,
        email: String,
        password: { type: String, select: false },
        balance: Number,
        role: String,
        lastLoginAt: Date
      },
      { timestamps: true }
    )
  );

  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    console.log('');
    console.log('RESULT: MASTER ACCOUNT NOT FOUND');
    return;
  }

  const passwordMatches = await bcrypt.compare(password, user.password);

  console.log('');
  console.log('Account found: YES');
  console.log('Username:', user.username);
  console.log('Role:', user.role);
  console.log('Password matches .env:', passwordMatches ? 'YES' : 'NO');
  console.log('');

  if (passwordMatches) {
    console.log('====================================');
    console.log('MASTER LOGIN DATA IS CORRECT');
    console.log('====================================');
    console.log('Now the website should accept the same');
    console.log('email and MASTER_PASSWORD from .env');
  } else {
    console.log('====================================');
    console.log('PASSWORD DOES NOT MATCH');
    console.log('====================================');
  }
}

checkMaster()
  .catch((error) => {
    console.error('');
    console.error('CHECK FAILED');
    console.error(error.message);
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });