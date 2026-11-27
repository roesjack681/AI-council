// Install before App/Naive UI imports create their shared observer during module evaluation.
import './sidepanel/runtime/resize-observer';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './sidepanel/App.vue';
import './sidepanel/styles.css';

createApp(App).use(createPinia()).mount('#app');
