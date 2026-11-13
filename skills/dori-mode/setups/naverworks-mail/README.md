# NAVER WORKS mail (dori mail)

`dori mail` reads the owner's NAVER WORKS (skku.edu) INBOX over IMAP and puts reply drafts into the drafts folder (임시보관함). It never sends, deletes, moves or marks mail read; the owner edits and sends each draft herself. Commands and output: `references/scripts.md` (`dori mail`).

## The owner does once

1. NAVER WORKS mail → settings (톱니) → 고급 설정 → POP3/IMAP → IMAP/SMTP: turn it on. If POP3/IMAP is not shown, the admin has not allowed it yet (Admin → 보안 → 권한).
2. 환경설정 → 보안 → 외부 앱 비밀번호: make an app password for this Dori. IMAP takes only this password, never the login password (help.worksmobile.com, use-guides/mail/settings/pop3-imap-smtp).
3. Put the two values into this Dori's `dori.env` (the Dori never writes them itself):

```
DORI_MAIL_IMAP_USER=<her address, e.g. name@skku.edu>
DORI_MAIL_IMAP_PASSWORD=<the app password>
```

## The filter

The Dori sees only mail that passes it, in `dori.env`:

```
DORI_MAIL_SENDERS=prof@example.ac.kr,orders@example.co.kr,@example.org
DORI_MAIL_SUBJECT_KEYWORDS=과제,연차보고서,회신 요청,성균관대학교,FW:,산학협력단
```

A mail passes when its sender is one of the addresses or in one of the `@domains`, or its decoded subject holds one of the words (any case, so `FW:` also catches `Fw:` and `fw:`; Korean words match inside the subject). Mail outside both is not listed, read or answered (`MAIL_REFUSED`). The server, `imap.worksmobile.com:993` (TLS), is the default; `DORI_MAIL_IMAP_HOST` and `DORI_MAIL_IMAP_PORT` change it.

## Check

`dori mail list` prints `MAIL_LIST N` and the matching mail of the last 7 days. `MAIL_FAIL LOGIN: NO ...` means IMAP is off or the app password is wrong. To take the Dori off the mailbox, delete the app password in NAVER WORKS.
