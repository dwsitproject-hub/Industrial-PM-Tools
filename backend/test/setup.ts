process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://engpro:engpro@localhost:5439/industrial_pm_test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_0123456789abcdef';
process.env.ACCESS_TTL = '15m';
process.env.REFRESH_TTL_DAYS = '7';
process.env.WORKSPACE_TZ = 'Asia/Jakarta';
process.env.THROTTLE_LIMIT = '30';
process.env.COOKIE_SECURE = 'false';
// The functional suites fire far more requests than a human would; the rate limiter itself
// is exercised deliberately in security.e2e-spec.ts with its own low limits.
process.env.THROTTLE_GLOBAL = process.env.THROTTLE_GLOBAL || '100000';
process.env.THROTTLE_HEAVY = process.env.THROTTLE_HEAVY || '100000';
process.env.DEPLOY_ENV = process.env.DEPLOY_ENV || 'local';
