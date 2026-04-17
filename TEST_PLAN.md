# BETTING SYSTEM FIXES - TEST PLAN

## Fixes Applied

### 1. Socket.IO Listener Registration (xadrez.html)
**Problem**: Listeners were registered at module level before socket connection
**Solution**: Moved all bet listeners to `registerBetListeners()` function and call it from `socket.on('connect')`
**Verification**: 
- registerBetListeners() function exists and is called in connect handler
- No more premature socket listener registration
- All listeners will only be registered AFTER socket successfully connects

### 2. betGameFinished Variable Reference (server.js:1562)
**Problem**: Event handler referenced undefined variable `bet`
**Solution**: Reconstruct bet object from `activeBetsData[betIndex]`
**Changes**:
```javascript
// OLD: io.emit with undefined bet
// NEW: 
const betForEmit = activeBetsData[betIndex] || {};
io.to(currentRoom).emit('betGameFinished', {
    winner: winner,
    bet: betForEmit,
    betId: betId
});
```
**Impact**: Bet finish notifications will now include valid bet data

### 3. Event Routing to User-Specific Rooms
**Problem**: All users received all bet events (io.emit broadcasts to everyone)
**Solution**: Changed to io.to(userId).emit() to send only to relevant players
**Events Fixed**:
- betAccepted (line 620)
- betPaymentConfirmed (lines 965, 1049)
- betPaymentFailed (line 1074)
- betPaymentPending (line 1096)
- betCompleted (line 1205)

## Manual Testing Checklist

### Test 1: Socket Connection
- [ ] User logs in
- [ ] Verify Socket.IO connects
- [ ] Check browser console for connection log
- [ ] Verify registerBetListeners() was called (add console.log to verify)

### Test 2: Create Bet
- [ ] User A creates bet with amount R$10
- [ ] Verify backend validates amount in ALLOWED_BET_AMOUNTS
- [ ] Verify bet appears in "Minhas Apostas"
- [ ] Verify only User A sees their own bet creation (not broadcasted to all)

### Test 3: Accept Bet
- [ ] User B accepts the bet from User A
- [ ] Verify betAccepted event is received by User A and User B only
- [ ] Verify User C (third user) does NOT receive betAccepted event
- [ ] Verify bet status changes to "accepted"

### Test 4: Payment Flow
- [ ] User A initiates payment (PIX or Card)
- [ ] User B initiates payment
- [ ] First payment: betPaymentConfirmed event sent to both players only
- [ ] Second payment: betPaymentConfirmed event received with readyToPlay=true
- [ ] Verify third player doesn't see payment events

### Test 5: Failed Payment
- [ ] User A initiates payment
- [ ] User A cancels payment in Mercado Pago
- [ ] Verify betPaymentFailed event is received by both players
- [ ] Verify bet returns to "accepted" status

### Test 6: Pending Payment
- [ ] User A initiates payment
- [ ] Payment enters "pending" status at Mercado Pago
- [ ] Verify betPaymentPending event is received by both players only

### Test 7: Game Finish
- [ ] Both players have paid, game starts
- [ ] One player wins
- [ ] Verify betGameFinished event contains valid bet data
- [ ] Verify winner is determined correctly
- [ ] Verify both players receive the event

### Test 8: Multiple Concurrent Bets
- [ ] Create 3 separate bets simultaneously
- [ ] Each pair of players should only see their own bet events
- [ ] No cross-contamination of events between different bets

### Test 9: Disconnect/Reconnect
- [ ] User in middle of accepted bet
- [ ] Simulate disconnect (close browser or network issue)
- [ ] Verify Socket.IO reconnection works
- [ ] Verify listeners are still active after reconnect
- [ ] Verify bet events are still received after reconnect

## Browser Console Checks

### Things that SHOULD appear:
1. "Conectando ao servidor atual..."
2. Connection status change to "conectado"
3. [PAGAMENTO-CONFIRMADO] messages
4. 'Entrou na sala de aposta:' log

### Things that SHOULD NOT appear:
1. "registerBetListeners is not defined"
2. "initSocket is not defined"
3. Errors about undefined 'bet' variable in console

## Performance Expectations

- Socket listeners should register within 100ms of connection
- Bet events should be received within 200ms of emission
- No memory leaks from repeated listener registration

## Regression Tests

Make sure these still work (were not broken by fixes):
- [ ] Game matchmaking still works
- [ ] Player colors still assigned correctly
- [ ] Move validation still works
- [ ] Tournament system still works (if separate)
- [ ] Chat/messaging still works (if applicable)

## Sign-Off

- [ ] All tests passed
- [ ] No console errors
- [ ] Bet events only reach intended players
- [ ] Socket connection is stable
- [ ] Ready for production deployment
