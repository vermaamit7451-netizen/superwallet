const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
const password = String(process.env.MASTER_PASSWORD || '');

async function testLogin() {
  console.log('');
  console.log('Testing SuperWallet login directly...');
  console.log('Email:', email);

  const response = await fetch('http://localhost:5000/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password
    })
  });

  const data = await response.json().catch(() => ({}));

  console.log('');
  console.log('HTTP Status:', response.status);
  console.log('Server Response:', data.message || JSON.stringify(data));

  if (response.ok) {
    console.log('');
    console.log('====================================');
    console.log('DIRECT LOGIN TEST: SUCCESS');
    console.log('====================================');
    console.log('Backend login is working correctly.');
  } else {
    console.log('');
    console.log('====================================');
    console.log('DIRECT LOGIN TEST: FAILED');
    console.log('====================================');
  }
}

testLogin().catch((error) => {
  console.error('');
  console.error('TEST FAILED');
  console.error(error.message);
});