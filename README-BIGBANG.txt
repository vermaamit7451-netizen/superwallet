SuperWallet + BigBang Game Lobby (Sandbox/Demo)

This build adds an optional BigBang Casino API integration for the provider Standard/Sandbox catalogue.
It does NOT connect SuperWallet wallet coins to wagers, wins, losses, or settlement.

Setup:
1. Keep your existing .env. Do not replace it.
2. Create a BigBang sandbox API key in the provider dashboard.
3. Add this line to your local .env:
   BIGBANG_API_KEY=ek_test_your_real_sandbox_key
4. Restart:
   npm run dev
5. Log in as a client. The Game Lobby will load the provider catalogue.
6. Click PLAY DEMO. The server requests a demo launch URL and opens it in the game modal.

Security:
- Never put BIGBANG_API_KEY in index.html or browser JavaScript.
- Never paste the real API key into chat.
- This build intentionally uses demo:true only.

Provider docs:
https://api.bigbangcasino.bet/docs/
