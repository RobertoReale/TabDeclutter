# Verifiche manuali

Ciò che i test automatici non possono verificare. Gli agenti aggiungono le voci; le spunta solo
l'utente, dopo averle provate. Non bloccano la sequenza automatica: si possono fare quando si
vuole, ma conviene farle per fase, così un problema si trova prima di costruirci sopra.

Formato: `- [ ] (<task>) <cosa fare> → <cosa deve succedere>`

## Prima della pubblicazione

- [ ] (setup) Confermare l'id Firefox `tabdeclutter@robertoreale` in `wxt.config.ts`, o cambiarlo → dopo il primo invio ad AMO non si può più cambiare
- [ ] (setup) Creare gli account sviluppatore (Chrome Web Store, AMO) e fare il primo invio a mano → PLAN.md §12.2, §12.3
