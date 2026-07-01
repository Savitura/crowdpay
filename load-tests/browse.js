import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 100 },  // ramp up to 100 anonymous users
    { duration: '1m', target: 100 },   // stay for 1 minute
    { duration: '10s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],    // error rate < 1%
    http_req_duration: ['p(95)<300'],  // 95% of requests under 300ms (browsing should be faster)
  },
};

export default function () {
  // 1. Browse the homepage (campaign list)
  const homeRes = http.get('https://your-app.com/api/campaigns?page=1&limit=20');
  check(homeRes, {
    'homepage loaded': (r) => r.status === 200,
    'campaigns returned': (r) => r.json().length > 0,
  });

  // 2. Pick a random campaign ID from the list (or use a fixed one)
  // For simplicity, we use a fixed campaign ID – you can randomise if needed
  const campaignId = 'abc-123'; // Replace with a real campaign ID that exists

  // 3. View campaign details
  const detailRes = http.get(`https://your-app.com/api/campaigns/${campaignId}`);
  check(detailRes, {
    'campaign detail loaded': (r) => r.status === 200,
    'campaign has title': (r) => r.json('title') !== undefined,
  });

  // 4. Optionally, fetch contributions for that campaign
  const contribRes = http.get(`https://your-app.com/api/contributions?campaignId=${campaignId}&limit=10`);
  check(contribRes, {
    'contributions list loaded': (r) => r.status === 200,
  });

  // Simulate user thinking / reading
  sleep(2);
}
