// Cấu hình web-ext cho repo dev: fixtures (HTML mẫu để test offline) và tools/
// (script Node chạy ngoài trình duyệt) KHÔNG được đóng gói vào .xpi khi build/lint.
export default {
  sourceDir: '.',
  artifactsDir: '../web-ext-artifacts',
  ignoreFiles: ['fixtures', 'tools', 'node_modules', '.git']
};
