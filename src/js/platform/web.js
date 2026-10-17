// 웹(Vercel): Vercel Analytics 사용
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
Platform.track = (name, props) => window.va('event', { name, data: props });
