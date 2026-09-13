SUPERWALLET - CUSTOMER SIGNUP DISABLED

What changed
- Customers cannot self-register anymore.
- Only Master and Admin can create customer IDs.
- Customer login uses username + password only.
- Email is no longer shown in customer, Master, or Admin UI.
- Master can create customers from the Master panel.
- Admin can create customers from the Admin panel.
- Client login URL: /client/login
- Master login URL: /master/login
- Admin login URL: /admin/login
- Root client URL: /
- Server listens on 0.0.0.0 so it can accept connections from a LAN or hosting provider.

Important for public internet
This project is currently a Node/MongoDB application. localhost:5000 is NOT a public website.
To make it open from any device/browser, deploy the Node app to a public host and use a cloud MongoDB connection (or a securely reachable MongoDB server). Then point a domain to the host and enable HTTPS.

Suggested public URL structure after deployment
https://YOUR-DOMAIN.com/
https://YOUR-DOMAIN.com/client/login
https://YOUR-DOMAIN.com/master/login
https://YOUR-DOMAIN.com/admin/login

Before production
1. Keep your real .env private. Do not upload it to GitHub.
2. Set a long random JWT_SECRET.
3. Set NODE_ENV=production.
4. Use a production MongoDB connection string.
5. Persist uploads/deposit-proofs because payment proof files are stored there.
6. Put HTTPS/reverse proxy in front of Node in production.
