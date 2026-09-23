import * as esbuild from 'esbuild';
await esbuild.build({ entryPoints: ['test/fixtures/src/react-app.jsx'], bundle: true, outfile: 'test/fixtures/build/react-app.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, minify: true, logLevel: 'warning' });
await esbuild.build({ entryPoints: ['test/fixtures/src/pm-app.js'], bundle: true, outfile: 'test/fixtures/build/pm-app.js', minify: true, logLevel: 'warning' });
console.log('fixtures built');
