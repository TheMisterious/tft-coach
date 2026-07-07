const path = require('path');
const OwWebpackPlugin = require('./build/OwWebpackPlugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: {
      background: './src/background/main.ts',
      desktop:    './src/ui/desktop/index.tsx',
      in_game:    './src/ui/in_game/index.tsx',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name]/[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.module\.css$/,
          use: ['style-loader', { loader: 'css-loader', options: { modules: true } }],
        },
        {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new OwWebpackPlugin({
        // copies public/ (manifest.json, HTML, icons) into dist/
        // and packages dist/ into releases/tft-coach-{version}.opk
        sourceDir:  path.resolve(__dirname, 'public'),
        outputDir:  path.resolve(__dirname, 'dist'),
        packageDir: path.resolve(__dirname, 'releases'),
        // copies hand-curated set data into dist/ so the app can fetch it at runtime
        dataDirs: [
          { from: path.resolve(__dirname, 'data'), to: path.resolve(__dirname, 'dist', 'data') },
        ],
      }),
    ],
    devtool: isDev ? 'inline-source-map' : false,
    externals: {
      // Overwolf's global is injected by the CEF host — don't bundle it
      'overwolf': 'overwolf',
      // Native Node.js addon — must be require()'d at runtime, never bundled.
      // NOTE: require() is not available in Overwolf's CEF background window,
      // so better-sqlite3 will fail when first called. Switch to sql.js if
      // SQLite persistence is needed in this environment.
      'better-sqlite3': 'commonjs better-sqlite3',
    },
  };
};
