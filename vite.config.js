// import { defineConfig } from 'vite'
// import vue from '@vitejs/plugin-vue'
// import path from 'path'

// export default defineConfig({
//   plugins: [vue()],
//   resolve: {
//     alias: {
//       '@': path.resolve(__dirname, 'src'),
//       '@components': path.resolve(__dirname, 'src/components'),
//       '@views': path.resolve(__dirname, 'src/views'),
//       '@assets': path.resolve(__dirname, 'src/assets'),
//       '@utils': path.resolve(__dirname, 'src/utils'),
//       '@api': path.resolve(__dirname, 'src/api'),
//       '@stores': path.resolve(__dirname, 'src/stores')
//     }
//   },
//   server: {
//     port: 3000,
//     open: true,
//   },
//   css: {
//     preprocessorOptions: {
//       scss: {
//         additionalData: '@use "@/assets/styles/variables.scss" as vars;'
//       }
//     }
//   }
// })

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// 引入自动导入插件 (来自第二份配置的核心功能)
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

// 引入组件库解析器 (关键！让按钮变蓝的地方)
// 既然你的代码里混用了 a-button (Arco) 和 n-button (Naive)，建议两个都加上
import { ArcoResolver, NaiveUiResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    
    // 1. 自动导入 Vue API (ref, computed 等)
    // 这样你就不用在每个文件里写 import { ref } from 'vue' 了
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        // 如果你需要自动导入 naive-ui 的 message/dialog 等
        {
          'naive-ui': [
            'useDialog',
            'useMessage',
            'useNotification',
            'useLoadingBar'
          ]
        }
      ],
      // 生成类型声明文件，放在 src 下
      dts: 'src/auto-imports.d.ts',
    }),

    // 2. 自动注册组件 (关键！)
    // 这会让 <a-button> 和 <n-button> 自动按需引入并加载样式
    Components({
      // 指定组件位置，默认是 src/components
      dirs: ['src/components'],
      // 配置解析器
      resolvers: [
        // 支持 Arco Design (<a-button>)
        ArcoResolver({
          sideEffect: true // 开启样式自动加载
        }),
        // 支持 Naive UI (<n-button>)
        NaiveUiResolver()
      ],
      // 生成类型声明文件
      dts: 'src/components.d.ts',
    })
  ],

  // 3. 路径别名 (保留自第一份配置)
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@views': path.resolve(__dirname, 'src/views'),
      '@assets': path.resolve(__dirname, 'src/assets'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@api': path.resolve(__dirname, 'src/api'),
      '@stores': path.resolve(__dirname, 'src/stores')
    }
  },

  // 4. 服务器配置
  server: {
    port: 3000,
    open: true,
  },

  // 5. CSS 预处理器配置 (保留自第一份配置)
  css: {
    preprocessorOptions: {
      scss: {
        // 确保你的 variables.scss 文件路径是正确的
        additionalData: '@use "@/assets/styles/variables.scss" as vars;'
      }
    }
  }
})