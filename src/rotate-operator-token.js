process.stderr.write('Offline token rotation is disabled because it cannot update the running HTTP server credential.\nUse: npm run cli -- operator rotate\n');
process.exitCode = 2;
