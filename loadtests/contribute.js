import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },  // ramp up to 50 users
    { duration: '1m', target: 50 },   // stay for 1 minute
    { duration: '10s', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], // error rate < 1%
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
  },
};

export default function () {
  // 1. Login
  const loginRes = http.post('https://your-app.com/api/auth/login', {
    email: 'test@example.com',
    password: 'password123',
  });
  check(loginRes, { 'login successful': (r) => r.status === 200 });
  const token = loginRes.json('token');

  // 2. Get campaign details (replace with actual campaign ID)
  const campaignId = 'abc-123';
  const headers = { Authorization: `Bearer ${token}` };
  const campaignRes = http.get(`https://your-app.com/api/campaigns/${campaignId}`, { headers });
  check(campaignRes, { 'campaign loaded': (r) => r.status === 200 });

  // 3. Submit contribution
  const payload = JSON.stringify({
    campaignId,
    amount: '5',
    asset: 'USDC',
  });
  const contribRes = http.post(
    'https://your-app.com/api/contributions',
    payload,
    { headers: { 'Content-Type': 'application/json', ...headers } }
  );
  check(contribRes, {
    'contribution created': (r) => r.status === 201,
  });

  sleep(1);
}
