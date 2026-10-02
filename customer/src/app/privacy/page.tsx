export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">プライバシーポリシー</h1>

        <p className="text-sm leading-relaxed">
          株式会社bonheur（以下、「当社」と言います。）は、個人情報保護に関する法令等を遵守し、個人情報の取得、利用および管理を適切に行い、以下の方針に基づき個人情報の保護に努めます。
        </p>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">1. 法令遵守</h2>
          <p className="text-sm leading-relaxed">
            当社は、情報社会における個人情報保護の重要性を認識し、法令およびその他の規範を遵守のうえ個人情報を取り扱います。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">2. 個人情報の取得について</h2>
          <p className="text-sm leading-relaxed">
            当社は、適法かつ公正な手段によって、お客様の個人情報を取得いたします。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">3. 個人情報の利用について</h2>
          <p className="text-sm leading-relaxed">
            当社では、お客様の個人情報を以下の目的以外には利用いたしません。
          </p>
          <ul className="text-sm leading-relaxed list-none pl-4 space-y-1">
            <li>(1) 当社が、お客様にご提供するサービス（施術等）の遂行上、必要な範囲内において利用すること</li>
            <li>(2) マーケティング活動、商品開発のため</li>
            <li>(3) 当社が運営する各店舗（グループ店舗）間で、予約情報・施術内容・カルテ（施術記録）・画像等のお客様の個人情報を共有し、店舗を跨いだご予約・施術・カルテ管理・ご連絡等のサービス提供および顧客管理のために利用すること</li>
          </ul>
          <p className="text-sm leading-relaxed">
            お客様の個人情報は、当社が運営するグループ全店舗で共通の顧客情報として管理・利用されます。これにより、いずれの店舗をご利用いただいた場合でも、一貫したサービスをご提供いたします。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">4. 個人情報の第三者提供について</h2>
          <p className="text-sm leading-relaxed">
            当社は、法令に定める場合を除き、個人情報を、事前に本人の同意を得ることなく、第三者に提供しません。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">5. 個人情報の適正な管理</h2>
          <p className="text-sm leading-relaxed">
            当社は、個人情報への不正アクセス、個人情報の持ち出し、紛失、破壊、改ざんおよび漏えいを防止するためのシステム、事務における安全措置を実行します。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">6. 個人情報の開示・訂正・利用停止・消去について</h2>
          <p className="text-sm leading-relaxed">
            当社は、本人が自己の個人情報について、開示・訂正・利用停止・消去等を求める権利を有していることを確認し、これらの要求ある場合には、異議なく速やかに対応します。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">7. 教育</h2>
          <p className="text-sm leading-relaxed">
            当社は、役員及び従業員に対し、個人情報の保護及び適正な管理方法についての研修を実施し、日常業務における個人情報の適正な取扱いを徹底します。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">8. 組織・体制</h2>
          <p className="text-sm leading-relaxed">
            当社は、個人情報保護管理者を任命し、個人情報の適正な管理を実施します。
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">9. 個人情報取り扱いの改善</h2>
          <p className="text-sm leading-relaxed">
            当店は個人情報の取り扱いに関して定期的に監査を行い、常に継続的改善に努めます。
          </p>
        </section>

        <div className="border-t pt-4 text-sm text-gray-600 space-y-1">
          <p className="font-semibold">【サービス提供者】</p>
          <p>株式会社bonheur</p>
          <p>東京都渋谷区道玄坂2丁目29番18号才藤第二ビル5階</p>
        </div>
      </div>
    </div>
  );
}
