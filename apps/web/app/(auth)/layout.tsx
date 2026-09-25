export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">M</span>
          <span className="brand-name">MANEXION<small>Salon OS</small></span>
        </div>
        <div>
          <h1>顧客・予約・カルテ・会計・再来店を<br />ひとつの顧客IDで。</h1>
          <p style={{ color: '#c9d3ea', marginTop: 14, maxWidth: 460 }}>
            予約台帳、電子カルテ、POS、LINE配信、LTV分析までを一つにまとめた美容サロン向け業務OS。
          </p>
        </div>
        <div style={{ color: '#7f8bab', fontSize: 12 }}>© MANEXION</div>
      </div>
      <div className="auth-panel">{children}</div>
    </div>
  );
}
