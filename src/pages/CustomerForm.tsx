import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, Field, Input, PageHeader, Select, Tag, Textarea } from '../components/ui'
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listAllTags,
  updateCustomer,
} from '../lib/api/customers'
import { staffList } from '../lib/api/store'
import type { OwnerType } from '../lib/domain/types'

/** S-05/06 付随: 顧客の新規登録・編集フォーム */
export function CustomerForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const existing = id ? getCustomer(id) : undefined
  const isEdit = Boolean(existing)

  const [name, setName] = useState(existing?.name ?? '')
  const [nameKana, setNameKana] = useState(existing?.nameKana ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [email, setEmail] = useState(existing?.email ?? '')
  const [birthday, setBirthday] = useState(existing?.birthday ?? '')
  const [gender, setGender] = useState(existing?.gender ?? '')
  const [channel, setChannel] = useState(existing?.channel ?? '')
  const [tags, setTags] = useState<string[]>(existing?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [warnings, setWarnings] = useState(existing?.warnings.join('\n') ?? '')
  const [visitCycleDays, setVisitCycleDays] = useState(existing?.visitCycleDays?.toString() ?? '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [ownerType, setOwnerType] = useState<OwnerType>(existing?.ownerType ?? 'salon')
  const [ownerStaffId, setOwnerStaffId] = useState(existing?.ownerStaffId ?? staffList[0].id)
  const [lineLinked, setLineLinked] = useState(existing?.lineLinked ?? false)
  const [error, setError] = useState('')

  const knownTags = listAllTags()

  const addTag = (t: string) => {
    const v = t.trim()
    if (v && !tags.includes(v)) setTags((prev) => [...prev, v])
    setTagDraft('')
  }

  const save = () => {
    if (!name.trim()) {
      setError('氏名は必須です')
      return
    }
    const input = {
      name: name.trim(),
      nameKana: nameKana.trim(),
      phone: phone.trim(),
      email: email.trim(),
      birthday: birthday || null,
      gender: (gender || null) as '女性' | '男性' | 'その他' | null,
      lineLinked,
      ownerType,
      ownerStaffId: ownerType === 'staff' ? ownerStaffId : null,
      tags,
      warnings: warnings.split('\n').map((w) => w.trim()).filter(Boolean),
      visitCycleDays: visitCycleDays ? Number(visitCycleDays) : null,
      note: note.trim(),
      channel: channel.trim(),
    }
    if (isEdit && existing) {
      updateCustomer(existing.id, input)
      navigate(`/customers/${existing.id}`)
    } else {
      const created = createCustomer(input)
      navigate(`/customers/${created.id}`)
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Customers" title={isEdit ? `顧客情報の編集 — ${existing?.name} 様` : '新規顧客登録'} />
      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="氏名 *">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 花子" />
          </Field>
          <Field label="フリガナ">
            <Input value={nameKana} onChange={(e) => setNameKana(e.target.value)} placeholder="ヤマダ ハナコ" />
          </Field>
          <Field label="電話番号">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="090-0000-0000" />
          </Field>
          <Field label="メールアドレス">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </Field>
          <Field label="生年月日">
            <Input value={birthday} onChange={(e) => setBirthday(e.target.value)} type="date" />
          </Field>
          <Field label="性別">
            <Select value={gender} onChange={setGender}>
              <option value="">未設定</option>
              <option value="女性">女性</option>
              <option value="男性">男性</option>
              <option value="その他">その他</option>
            </Select>
          </Field>
          <Field label="来店経路">
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Instagram / 紹介 など" />
          </Field>
          <Field label="来店周期（日）">
            <Input value={visitCycleDays} onChange={(e) => setVisitCycleDays(e.target.value)} type="number" placeholder="45" />
          </Field>
          <Field label="所有区分">
            <Select value={ownerType} onChange={(v) => setOwnerType(v as OwnerType)}>
              <option value="salon">サロン顧客</option>
              <option value="staff">スタッフ個人顧客</option>
            </Select>
          </Field>
          {ownerType === 'staff' ? (
            <Field label="所有スタッフ">
              <Select value={ownerStaffId} onChange={setOwnerStaffId}>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="LINE連携">
              <Select value={lineLinked ? '1' : '0'} onChange={(v) => setLineLinked(v === '1')}>
                <option value="0">未連携</option>
                <option value="1">連携済</option>
              </Select>
            </Field>
          )}
        </div>

        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">タグ</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button key={t} type="button" onClick={() => setTags((prev) => prev.filter((x) => x !== t))} title="クリックで削除">
                <Tag tone={t === 'VIP' ? 'gold' : 'neutral'}>{t} ×</Tag>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="タグを入力してEnter"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  addTag(tagDraft)
                }
              }}
            />
            <Button variant="ghost" onClick={() => addTag(tagDraft)} disabled={!tagDraft.trim()}>
              追加
            </Button>
          </div>
          {knownTags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {knownTags
                .filter((t) => !tags.includes(t))
                .map((t) => (
                  <button key={t} type="button" onClick={() => addTag(t)} className="text-[11px] text-stone hover:text-gold-deep">
                    + {t}
                  </button>
                ))}
            </div>
          ) : null}
        </div>

        <Field label="警告（アレルギー・皮膚トラブル等。1行に1件 — カルテ最上部に強調表示されます）">
          <Textarea rows={2} value={warnings} onChange={(e) => setWarnings(e.target.value)} placeholder="例：ジアミンアレルギー" />
        </Field>

        <Field label="メモ">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {error ? <p className="rounded-md bg-clay-tint px-4 py-3 text-[13px] text-clay">{error}</p> : null}

        <div className="flex flex-wrap gap-3">
          <Button onClick={save}>{isEdit ? '保存する' : '登録する'}</Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
          {isEdit && existing ? (
            <Button
              variant="danger"
              className="ml-auto"
              onClick={() => {
                if (window.confirm(`${existing.name} 様を削除します（カルテ・会計履歴は保持されます）。よろしいですか？`)) {
                  deleteCustomer(existing.id)
                  navigate('/customers')
                }
              }}
            >
              顧客を削除
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
