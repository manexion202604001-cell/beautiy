export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">サービス利用規約</h1>
        <p className="text-sm text-gray-500">最終更新日: 2026年4月10日</p>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第1条（適用）</h2>
          <p className="text-sm leading-relaxed">
            本規約は、株式会社bonheur（以下「当社」）が提供するサロン予約管理サービス「SALOGIC」（以下「本サービス」）の利用に関する条件を定めるものです。本サービスをご利用いただくことにより、本規約に同意したものとみなします。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第2条（サービス内容）</h2>
          <p className="text-sm leading-relaxed">本サービスは、以下の機能を提供します。</p>
          <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
            <li>サロンの予約管理</li>
            <li>同意書の電子記入・提出</li>
            <li>カウンセリングシートの記入・管理</li>
            <li>LINEを通じたお客様との連絡</li>
            <li>施術記録（カルテ）の管理</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第3条（利用条件）</h2>
          <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
            <li>本サービスの利用にあたっては、正確な情報をご提供ください。</li>
            <li>他のお客様やサロンスタッフへの迷惑行為はお控えください。</li>
            <li>本サービスの不正利用、リバースエンジニアリング等は禁止します。</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第4条（LINE連携）</h2>
          <p className="text-sm leading-relaxed">
            本サービスはLINEミニアプリおよびLINE公式アカウントと連携しています。LINE経由でご利用いただく場合、LINEヤフー株式会社の利用規約も適用されます。当社はLINEから取得した情報を、本サービスの提供および改善のために利用します。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第5条（知的財産権）</h2>
          <p className="text-sm leading-relaxed">
            本サービスに関する知的財産権は、当社または正当な権利者に帰属します。本サービスの利用は、これらの権利の譲渡を意味するものではありません。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第6条（免責事項）</h2>
          <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
            <li>当社は、本サービスの完全性、正確性、継続性を保証するものではありません。</li>
            <li>システムメンテナンスや障害等により、一時的にサービスを停止する場合があります。</li>
            <li>本サービスの利用により生じた損害について、当社の故意または重過失による場合を除き、責任を負いません。</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第7条（サービスの変更・終了）</h2>
          <p className="text-sm leading-relaxed">
            当社は、事前の通知なく本サービスの内容を変更、または提供を終了することがあります。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第8条（規約の変更）</h2>
          <p className="text-sm leading-relaxed">
            当社は、必要に応じて本規約を変更することがあります。変更後の規約は、本ページに掲載した時点から効力を生じるものとします。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">第9条（準拠法・管轄）</h2>
          <p className="text-sm leading-relaxed">
            本規約は日本法に準拠するものとし、本サービスに関する紛争は東京地方裁判所を第一審の専属的合意管轄裁判所とします。
          </p>
        </section>

        <div className="border-t pt-4 text-sm text-gray-500">
          <p>株式会社bonheur</p>
        </div>
      </div>
    </div>
  );
}
