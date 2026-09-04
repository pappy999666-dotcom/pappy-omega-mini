// Test runs must never touch the live session storage tree. Running the
// suite as root previously wrote root-owned fixture dirs into
// ./storage/sessions, which the production service (running as the
// `pappy-omega` user) could neither read nor purge — producing permanent
// EACCES log/retry storms at every boot. Redirect session storage to a
// throwaway directory for every test run; an explicit SESSION_ROOT from the
// caller always wins.
process.env.SESSION_ROOT ??= `/tmp/pappy-omega-mini-test-sessions-${process.pid}`;