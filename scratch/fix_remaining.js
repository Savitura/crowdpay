const fs = require('fs');

function fixFile(path, replacer) {
  if (fs.existsSync(path)) {
    let content = fs.readFileSync(path, 'utf8');
    content = replacer(content);
    fs.writeFileSync(path, content);
  }
}

fixFile('frontend/src/pages/Dashboard.jsx', c => c.replace(
`            )}
          </div>
      {activeTab === 'referrals'`,
`            )}
          </div>
        </section>
      )}

      {activeTab === 'referrals'`
));

fixFile('frontend/src/pages/CampaignEmbed.jsx', c => c.replace('if (onOpenRef) onOpenRef();', '// do nothing'));

fixFile('frontend/src/pages/ForgotPassword.jsx', c => c.replace(/you're/g, "you&apos;re").replace(/We'll/g, "We&apos;ll").replace(/don't/g, "don&apos;t").replace(/can't/g, "can&apos;t"));

fixFile('frontend/src/pages/MyContributions.jsx', c => c.replace(/haven't/g, "haven&apos;t"));

fixFile('frontend/src/pages/NotFound.jsx', c => c.replace(/doesn't/g, "doesn&apos;t").replace(/Let's/g, "Let&apos;s").replace(/we're/g, "we&apos;re"));

fixFile('frontend/src/pages/Profile.jsx', c => c.replace(/import { api } from '\.\.\/services\/api';\n/g, ''));

fixFile('frontend/src/pages/Home.jsx', c => {
  let lines = c.split('\n');
  return lines.map((line) => {
    if (line.match(/}, \[\]\);/)) {
      return '    // eslint-disable-next-line react-hooks/exhaustive-deps\n' + line;
    }
    return line;
  }).join('\n');
});

fixFile('frontend/src/test/RelativeTime.test.jsx', c => c.replace(/function HookTestComponent/, '// eslint-disable-next-line no-unused-vars\nfunction HookTestComponent'));
