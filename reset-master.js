const bcrypt = require('bcryptjs');
const { mongoose, connectDatabase } = require('./db');

async function resetMasterPassword() {
  const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const newPassword = String(process.env.MASTER_PASSWORD || '');

  if (!email || !newPassword) {
    throw new Error('MASTER_EMAIL or MASTER_PASSWORD is missing in .env');
  }

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
    throw new Error(
      `Master account not found for ${email}. Start server.js once first.`
    );
  }

  user.password = await bcrypt.hash(newPassword, 12);
  user.role = 'admin';

  await user.save();

  console.log('');
  console.log('========================================');
  console.log('MASTER PASSWORD RESET SUCCESSFUL');
  console.log('========================================');
  console.log(`Email: ${email}`);
  console.log('Password: MASTER_PASSWORD from .env');
  console.log('Role: admin');
  console.log('========================================');
  console.log('');
}

resetMasterPassword()
  .catch((error) => {
    console.error('');
    console.error('MASTER PASSWORD RESET FAILED');
    console.error(error.message);
    console.error('');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });