// force use emulator to prevent accidental operate remote
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8500';
