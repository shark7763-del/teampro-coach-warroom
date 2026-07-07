# Rollback 腳本

這裡的 `*_down.sql` 是**回滾腳本**，**刻意不放在 `migrations/`**，
因為 `supabase db reset` / `db push` 會把 `migrations/` 內所有 `.sql` 當成
正向遷移依序執行——若回滾腳本留在該資料夾，會「建好又立刻刪掉」。

## 使用方式

回滾對應的正向遷移（執行前先備份 `supabase db dump`）：

```bash
# 例：回滾 007 backfill
supabase db execute -f supabase/rollback/007_backfill_coach_to_org_down.sql

# 例：回滾 006 多租戶 schema
supabase db execute -f supabase/rollback/006_multitenant_governance_down.sql
```

回滾順序需與遷移相反：先 007，再 006。

| 正向遷移 | 回滾腳本 |
|---|---|
| `migrations/006_multitenant_governance.sql` | `rollback/006_multitenant_governance_down.sql` |
| `migrations/007_backfill_coach_to_org.sql` | `rollback/007_backfill_coach_to_org_down.sql` |
