/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'client-no-server-import',
      severity: 'error',
      from: { path: '^src/client/' },
      to: { path: '^src/server/' }
    },
    {
      name: 'server-no-client-import',
      severity: 'error',
      from: { path: '^src/server/' },
      to: { path: '^src/client/' }
    },
    {
      name: 'common-runtime-independent',
      severity: 'error',
      from: { path: '^src/common/' },
      to: { path: '^src/(app|client|server)/' }
    },
    {
      name: 'runtime-no-app-import',
      severity: 'error',
      from: { path: '^src/(client|server)/' },
      to: { path: '^src/app/' }
    },
    {
      name: 'app-only-composes-entry-layers',
      severity: 'error',
      from: { path: '^src/app/' },
      to: { path: '^src/(client|server)/(l2_biz|l3_modules)/' }
    },
    {
      name: 'client-l1-no-l3-import',
      severity: 'error',
      from: { path: '^src/client/l1_entry/' },
      to: { path: '^src/client/l3_modules/' }
    },
    {
      name: 'server-l1-no-l3-import',
      severity: 'error',
      from: { path: '^src/server/l1_entry/' },
      to: { path: '^src/server/l3_modules/' }
    },
    {
      name: 'client-l4-no-upward-import',
      severity: 'error',
      from: { path: '^src/client/l4_foundation/' },
      to: { path: '^src/client/l[123]_' }
    },
    {
      name: 'client-l3-no-upward-import',
      severity: 'error',
      from: { path: '^src/client/l3_modules/' },
      to: { path: '^src/client/l[12]_' }
    },
    {
      name: 'client-l2-no-peer-business-import',
      severity: 'error',
      from: { path: '^src/client/l2_biz/([^/]+)/' },
      to: { path: '^src/client/l2_biz/', pathNot: '^src/client/l2_biz/$1/' }
    },
    {
      name: 'server-l2-no-peer-business-import',
      severity: 'error',
      from: { path: '^src/server/l2_biz/([^/]+)/' },
      to: { path: '^src/server/l2_biz/', pathNot: '^src/server/l2_biz/$1/' }
    },
    {
      name: 'client-l2-no-l1-import',
      severity: 'error',
      from: { path: '^src/client/l2_biz/' },
      to: { path: '^src/client/l1_entry/' }
    },
    {
      name: 'server-l4-no-upward-import',
      severity: 'error',
      from: { path: '^src/server/l4_foundation/' },
      to: { path: '^src/server/l[123]_' }
    },
    {
      name: 'server-l3-no-upward-import',
      severity: 'error',
      from: { path: '^src/server/l3_modules/' },
      to: { path: '^src/server/l[12]_' }
    },
    {
      name: 'server-l2-no-l1-import',
      severity: 'error',
      from: { path: '^src/server/l2_biz/' },
      to: { path: '^src/server/l1_entry/' }
    },
    {
      name: 'common-l4-no-upward-import',
      severity: 'error',
      from: { path: '^src/common/l4_foundation/' },
      to: { path: '^src/common/l[23]_' }
    },
    {
      name: 'common-l3-no-l2-import',
      severity: 'error',
      from: { path: '^src/common/l3_modules/' },
      to: { path: '^src/common/l2_biz/' }
    },
    {
      name: 'client-l4-common-l4-only',
      severity: 'error',
      from: { path: '^src/client/l4_foundation/' },
      to: { path: '^src/common/l[23]_' }
    },
    {
      name: 'client-l3-no-common-l2-import',
      severity: 'error',
      from: { path: '^src/client/l3_modules/' },
      to: { path: '^src/common/l2_biz/' }
    },
    {
      name: 'server-l4-common-l4-only',
      severity: 'error',
      from: { path: '^src/server/l4_foundation/' },
      to: { path: '^src/common/l[23]_' }
    },
    {
      name: 'server-l3-no-common-l2-import',
      severity: 'error',
      from: { path: '^src/server/l3_modules/' },
      to: { path: '^src/common/l2_biz/' }
    }
  ],
  options: {
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    tsPreCompilationDeps: true,
    includeOnly: '^src/'
  }
}
