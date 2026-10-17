const fs = require('fs');
const path = require('path');

function verifyRouterMounts() {
  const routesDir = path.join(__dirname, '../routes');
  const indexPath = path.join(__dirname, '../index.js');
  const v1Path = path.join(__dirname, '../routes/v1.js');

  const indexContent = fs.readFileSync(indexPath, 'utf8');
  let v1Content = '';
  if (fs.existsSync(v1Path)) {
    v1Content = fs.readFileSync(v1Path, 'utf8');
  }

  const files = fs.readdirSync(routesDir);
  const routerFiles = files.filter(
    f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'v1.js'
  );

  const unmounted = [];
  for (const file of routerFiles) {
    const baseName = path.basename(file, '.js');
    const referencedInIndex = indexContent.includes(file) || indexContent.includes(baseName);
    const referencedInV1 = v1Content.includes(file) || v1Content.includes(baseName);
    if (!referencedInIndex && !referencedInV1) {
      unmounted.push(file);
    }
  }

  if (unmounted.length > 0) {
    console.error(
      `[check_index] Error: The following router files are not mounted in index.js or v1.js:\n${unmounted.map(f => `  - backend/src/routes/${f}`).join('\n')}`
    );
    process.exit(1);
  }

  console.log('[check_index] All router files are properly mounted.');
}

verifyRouterMounts();
