const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/superwallet';

const MASTER_EMAIL = 'master@superwallet.local';
const MASTER_USERNAME = 'master01';
const MASTER_PASSWORD = 'Master@12345';

const ADMIN_EMAIL = 'admin@superwallet.local';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@12345';

async function main() {
  await mongoose.connect(MONGODB_URI);

  console.log('MongoDB connected.');

  const users = mongoose.connection.collection('users');

  // =====================================================
  // 1. FIND MASTER AND ADMIN BY EMAIL
  // =====================================================

  let master = await users.findOne({ email: MASTER_EMAIL });
  let admin = await users.findOne({ email: ADMIN_EMAIL });

  // =====================================================
  // 2. IF ADMIN EMAIL ACCOUNT DOES NOT EXIST,
  //    FIND EXISTING SUPERADMIN
  // =====================================================

  if (!admin) {
    admin = await users.findOne({ role: 'superadmin' });
  }

  // =====================================================
  // 3. IF MASTER EMAIL ACCOUNT DOES NOT EXIST,
  //    FIND EXISTING ADMIN
  // =====================================================

  if (!master) {
    master = await users.findOne({ role: 'admin' });
  }

  if (!master) {
    console.log('❌ Master account nahi mila.');
  } else {
    console.log('✅ Master account found:', master.email || master.username);
  }

  if (!admin) {
    console.log('❌ Admin account nahi mila.');
  } else {
    console.log('✅ Admin account found:', admin.email || admin.username);
  }

  // =====================================================
  // 4. TEMPORARILY MOVE MASTER + ADMIN USERNAMES
  //    This prevents username collision.
  // =====================================================

  if (master) {
    await users.updateOne(
      { _id: master._id },
      {
        $set: {
          username: `__master_temp_${String(master._id)}`
        }
      }
    );
  }

  if (admin) {
    await users.updateOne(
      { _id: admin._id },
      {
        $set: {
          username: `__admin_temp_${String(admin._id)}`
        }
      }
    );
  }

  // =====================================================
  // 5. FREE "admin" USERNAME FROM ANY OTHER ACCOUNT
  // =====================================================

  const adminUsernameOwner = await users.findOne({
    username: ADMIN_USERNAME
  });

  if (adminUsernameOwner) {
    await users.updateOne(
      { _id: adminUsernameOwner._id },
      {
        $set: {
          username: `old_admin_${String(adminUsernameOwner._id).slice(-8)}`
        }
      }
    );

    console.log('⚠️ Old "admin" username freed.');
  }

  // =====================================================
  // 6. FREE "master01" USERNAME FROM ANY OTHER ACCOUNT
  // =====================================================

  const masterUsernameOwner = await users.findOne({
    username: MASTER_USERNAME
  });

  if (masterUsernameOwner) {
    await users.updateOne(
      { _id: masterUsernameOwner._id },
      {
        $set: {
          username: `old_master_${String(masterUsernameOwner._id).slice(-8)}`
        }
      }
    );

    console.log('⚠️ Old "master01" username freed.');
  }

  // =====================================================
  // 7. SET MASTER CORRECTLY
  // =====================================================

  if (master) {
    const passwordHash = await bcrypt.hash(MASTER_PASSWORD, 12);

    await users.updateOne(
      { _id: master._id },
      {
        $set: {
          username: MASTER_USERNAME,
          email: MASTER_EMAIL,
          password: passwordHash,
          role: 'admin'
        }
      }
    );

    console.log('');
    console.log('✅ MASTER READY');
    console.log('Username:', MASTER_USERNAME);
    console.log('Password:', MASTER_PASSWORD);
  }

  // =====================================================
  // 8. SET ADMIN CORRECTLY
  // =====================================================

  if (admin) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await users.updateOne(
      { _id: admin._id },
      {
        $set: {
          username: ADMIN_USERNAME,
          email: ADMIN_EMAIL,
          password: passwordHash,
          role: 'superadmin'
        }
      }
    );

    console.log('');
    console.log('✅ ADMIN READY');
    console.log('Username:', ADMIN_USERNAME);
    console.log('Password:', ADMIN_PASSWORD);
  }

  // =====================================================
  // 9. FINAL CHECK
  // =====================================================

  const finalMaster = await users.findOne({
    username: MASTER_USERNAME
  });

  const finalAdmin = await users.findOne({
    username: ADMIN_USERNAME
  });

  console.log('');
  console.log('====================================');
  console.log('FINAL LOGIN CHECK');
  console.log('====================================');

  if (finalMaster) {
    console.log('✅ MASTER:', finalMaster.username);
  } else {
    console.log('❌ MASTER NOT FOUND');
  }

  if (finalAdmin) {
    console.log('✅ ADMIN:', finalAdmin.username);
  } else {
    console.log('❌ ADMIN NOT FOUND');
  }

  console.log('====================================');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('');
  console.error('❌ FIX FAILED');
  console.error(error);

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});