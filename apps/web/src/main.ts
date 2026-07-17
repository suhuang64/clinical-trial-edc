import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'vant/lib/index.css'
import App from './App.vue'
import { i18n } from './app/i18n'
import { pinia } from './app/pinia'
import { router } from './app/router'
import './styles/index.css'

createApp(App).use(pinia).use(i18n).use(router).use(ElementPlus).mount('#app')
