// 탭 전환: 주소 경로(/ · /converter · /calendar)에 맞는 화면 하나만 보여준다.
// 탭을 누르면 새로고침 없이 경로만 바꾸고(pushState), 뒤로가기(popstate)도 같은 방식으로 처리한다.
(() => {
  const VIEWS = ['home', 'converter', 'calendar'];
  const pathOf = view => (view === 'home' ? './' : view);
  function viewOf(pathname) {
    const last = pathname.replace(/\/+$/, '').split('/').pop();
    return VIEWS.includes(last) ? last : 'home';
  }
  function show(view) {
    for (const v of VIEWS) document.getElementById('view-' + v).hidden = v !== view;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-view]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const view = a.dataset.view;
    if (view !== viewOf(location.pathname)) history.pushState(null, '', pathOf(view));
    show(view);
    window.scrollTo(0, 0);
  });
  window.addEventListener('popstate', () => show(viewOf(location.pathname)));
  show(viewOf(location.pathname));
})();
