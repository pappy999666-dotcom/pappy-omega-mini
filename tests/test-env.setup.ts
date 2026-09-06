// Test runs must never touch the live session storage tree. Running the
// suite as root previously wrote root-owned fixture dirs into
// ./storage/sessions, which the production service (running as the
// `pappy-omega` user) could neither read nor purge — producing permanent
// EACCES log/retry storms at every boot. Redirect session storage to a
// throwaway directory for every test run; an explicit SESSION_ROOT from the
// caller always wins.
process.env.SESSION_ROOT ??= `/tmp/pappy-omega-mini-test-sessions-${process.pid}`;

// Test runs must also never touch the production databases. Suites that
// exercise pairing flows previously wrote hundreds of PAIRING session stubs
// straight into the live `pappy_omega_mini` Mongo database (and queued work
// into the live Redis instance), which the registry then hydrated as ghost
// "awaiting pairing" sessions after every restart. Point both at dedicated
// test databases; explicit caller-provided values always win.
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/pappy_omega_mini_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379/15";