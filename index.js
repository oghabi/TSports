var express = require('express');
var app = express();
var pg = require('pg');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var busboy = require('connect-busboy'); //middleware for form/file upload
var path = require('path');     //used for file path
var fs = require('fs-extra');   //File System - for file manipulation
var passport = require('passport'); //module for fb authen
var http = require('http');
var bcrypt = require('bcrypt-nodejs');

var Database = require('./db'); //no need for .js

//pg.defaults.ssl = true;

app.use(busboy());

//set the port #
app.set('port', (process.env.PORT || 3000));  // 'postgres://tyvhgoqverwgjf:LbL8CWzLwoh_LoQUoOMMP7iNCV@ec2-54-243-42-108.compute-1.amazonaws.com:5432/dbgvkt98mobtuk'

// required for passport
app.use(passport.initialize());
app.use(passport.session());

// views is directory for all template files
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

//Gets all the other files(htmls & css & js) for us, no need for app.get
app.use(express.static(__dirname + '/front_end'));
app.use(cookieParser());

//Form Form Input Submissions
app.use( bodyParser.json());       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
                               extended: true
                              })
       );



app.get('/', function (req, res)
             {
                res.sendFile(__dirname + '/front_end/index.html');
             }
       );


/****************************************WebSockets***********************************/
var server = app.listen(app.get('port'));
var io = require('socket.io').listen(server);

//This socket multiplex is only used for notifications (friendreqs, messages, notifications)
var NotificationSocket = io.of('/Notifications');

//This socket multiplex is only used for one to one messaging (sending the data)
var One2OneMessageSocket = io.of('/One2OneMessaging');

//This socket multiplex is only used for Event Chat messaging (sending the data)
var EventGroupChatSocket = io.of('/EventGroupChat');
/**************************************************************************************/


//socket is the incoming socket
//As soon as a client connects, the function is run
NotificationSocket.on('connection',
                      
                      function(socket)
                       {

                      
                           //Add a listener if a user "Adds a Friend"
                           socket.on('/AddAsFriend',
                                         function(msg)
                                         {
                                             //msg.userid and msg.friendid are sent via the "NotificationSocket" multiplexed socket as a JSON file
            
                                             //Insert Friend request in Friends table with status 0 initially (pending)
                                             //Instead of res and req, pass in msg.userid ,msg.friendid [Cuz sockets have no HTTP req and res]
                                             var sql = 'INSERT INTO Friends (friend_one, friend_two, status, WhoInitiated) ' + "VALUES($1, $2, 0, $3);";
                                             Database.query(sql, [msg.userid, msg.friendid, msg.userid], GenericCB, msg.userid, msg.friendid );
                                             var sql_1 = 'INSERT INTO Friends (friend_one, friend_two, status, WhoInitiated) ' + "VALUES($1, $2, 0, $3);";
                                             Database.query(sql_1, [msg.friendid, msg.userid, msg.userid], UpdateNotificationsCB, msg.friendid, msg.userid );
                                         }
                                     );
                       
                       }

                   );

/*****************************************AddAsFriend*****************************************************************/
//Update notifications for the person who was added by us
function UpdateNotificationsCB(err, result,friendid, userid)
{
    
    if (err)
    {
        console.error(err);
    }
    
    else
    {
        //increase their friendreq number
        //Return the numfriendreqs
        var sql = "UPDATE UnreadNotifications SET numfriendreqs = (numfriendreqs+1) where userid = $1 RETURNING numfriendreqs;";
        Database.query(sql, [friendid], AddAsFriendCB, friendid, userid );
    }
}

//use the returned new numfriendreqs to update the notifications of the added user
//Real-time using socket.io
function AddAsFriendCB(err, result, friendid, userid)
{
    
    if (err)
    {
        console.error(err);
    }
    
    else
    {
         //Pass the new numfriendreqs to the socket
         //Send this message in the "NotificationSocket" namespace to everyone
         //But because of the friendid, only the person who got added will be listening to this message
         NotificationSocket.emit('FriendNotification' + friendid, result.rows[0].numfriendreqs);
    }
}
/*****************************************END AddAsFriend*****************************************************************/


//socket is the incoming socket
//As soon as a client connects, the function is run
One2OneMessageSocket.on('connection',
                        
                        function(socket)
                        {
                        
                        
                            //Add a listener if anyone sent a message
                            socket.on('/SendingMessage',
                                       function(msg)
                                       {

                                          //Insert the sent message into the database
                                          var sql = 'INSERT INTO OneToOneChat (sentById, ReceivedById, chatmessage, MessageTime) ' + "VALUES($1, $2, $3, now());";
                                          Database.query(sql, [msg.userid, msg.chattingToid, msg.chatmessage], GenericCB, msg.userid, msg.chattingToid );
                                          
                                          //Update the UnreadNotifications table for the person to whom the message was sent
                                          var sql1 = "UPDATE UnreadNotifications SET nummessages = (nummessages+1) where userid = $1 RETURNING nummessages;";
                                          Database.query(sql1, [msg.chattingToid], SendMessageCB, msg.userid, msg ); //pass the msg object,(No http req and res)
                                       }
                                      );
                            
                            //Add a listener if a message was read
                            socket.on('/ReadMessage',
                                                  function(msg)
                                                  {
                                                      //msg.userid is sent
                                                      //Update the UnreadNotifications table for the person to who read a message
                                                      var sql1 = "UPDATE UnreadNotifications SET nummessages = (nummessages-1) where userid = $1;";
                                                      Database.query(sql1, [msg.userid], GenericCB, msg.userid, msg );
                                                  }
                                      );
                        
 
                        }
                        
                        );


/*****************************************Send Message*****************************************************************/
//Send new nummessages to update the notifications and send the message content through the One2OneMessageSocket
function SendMessageCB(err, result, userid, msg)
{
    
    if (err)
    {
        console.error(err);
    }
    
    else
    {
        //Pass a JSON containg the new nummessages, the fromuserid, and the chatmessage
        //Send this message to everyone in the "One2OneMessageSocket.emit" namespace [Including the sender]
        //But because of the chattingToid, only the person who it got sent to will be listening to this message
        One2OneMessageSocket.emit('ReceiveMessages' + msg.chattingToid, {nummessages: result.rows[0].nummessages, fromuserid: msg.userid, chatmessage: msg.chatmessage  } );
    }
}
/*****************************************End Send Message*****************************************************************/



//socket is the incoming socket
//As soon as a client connects, the function is run
EventGroupChatSocket.on('connection',
                      
                                  function(socket)
                                  {
                        
                                        socket.on('JoinEventRoom', function(room)
                                                                  {
                                                                      //room is the EventID passed
                                                                      //The socket/client that sent this message joins a room dedicated for this EventID
                                                                      socket.join(room);
                                                                  }
                                                  );
                        
                        
                                      //Add a listener if a user in the event Sends Group Message
                                      socket.on('/SendGroupMessage',
                                                                function(msg)
                                                                {
                                                                    //Insert the sent message into the database
                                                                    var sql = 'INSERT INTO EventGroupChat (eventid, sentById, chatmessage, MessageTime) ' + "VALUES($1, $2, $3, now());";
                                                                    Database.query(sql, [msg.Chat_EventID, msg.userid, msg.chatmessage], GenericCB, msg.userid, msg);
                                                
                                                                    //Get the profile picture of the person who sent the message
                                                                    var sql = "SELECT ProfileImage FROM Users where id = $1;";
                                                                    Database.query(sql, [msg.userid], SendGroupMessageCB, socket, msg);
                                                                }
                                               );
                        
                        
                                      socket.on('LeaveRoom', function(room)
                                                            {
                                                               //console.log("LeavingRoom: " + room);
                                                               //Client leaves the room
                                                               socket.leave(room);
                                                            }
                                              );
                      
                                  }
                      
                      );


/*****************************************SendGroupMessage*****************************************************************/
//Broadcast the chat group message to all other users in the event
function SendGroupMessageCB(err, result, socket, msg)
{
    
    if (err)
    {
        console.error(err);
    }
    
    else
    {
        //Broadcast the message to all other users in the socket room/event [Except to the sender]
        socket.broadcast.to(msg.Chat_EventID).emit('ReceiveEventMessages', {eventID: msg.Chat_EventID, chatmessage: msg.chatmessage, SenderDP: result.rows[0].profileimage  });
    }
}
/*****************************************End SendGroupMessage*****************************************************************/























/*****************************************USER REGISTRATION*****************************************************************/


//User Registration
app.post('/UserRegistration', function(req, res)
                             {
                                //console.log( req.body );
         
                                //Server-Side Form Validation (Check if e-mail already exists)
                                var sql = 'SELECT * FROM users where email = $1;';
                                Database.query(sql, [req.body.email], NewUserCB, res, req );
                             }
        );



//Check if email already exists
function NewUserCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    
    //Row (Email) already exists
    //Send an error message to AJAX
    else if( result.rowCount == 1 )
    {
        //Send it to AJAX
        res.send( "emailexists" );
    }

    
    //Email doesn't exist
    //Insert user info in database
    else
    {
        //New User
        //insert in the DB
        //hash the password before storing it
        var hashedPass = bcrypt.hashSync(req.body.password);
        var sql = 'INSERT INTO users (first_name, last_name, birthday, gender, height, weight, email, phone, campus, password, about, createdAt, ProfileImage,hashedpassword) ' + "VALUES($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, now(), './assets/images/DefaultProfilePic.jpg',$12);";
        Database.query(sql, [req.body.firstname, req.body.lastname,  req.body.birthday, req.body.gender, req.body.height, req.body.weight, req.body.email, req.body.phone, req.body.campus, req.body.password, req.body.about,hashedPass ], GetUserIDCB, res, req );
        
   

    }
    
}


//Get the user's ID to enter it in the Interests table for sports preferences
function GetUserIDCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
        
    }
    else
    {
        var sql = 'SELECT id FROM users where email = $1;';
        Database.query(sql, [req.body.email], InsertUserSportPrefCB, res, req );
    }
    
}


function InsertUserSportPrefCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
       // console.log(result.rows[0].id);
        
        //Get each sport submitted by form
        var SportsInterested=[];
        
        
        if(req.body.hasOwnProperty('cycling'))
        {
            SportsInterested.push(1); //The code for cycling
        }
        
        if(req.body.hasOwnProperty('waterpolo'))
        {
            SportsInterested.push(2); //The code for waterpolo
        }
        
        if(req.body.hasOwnProperty('squash'))
        {
            SportsInterested.push(3); //The code for squash
        }
        
        if(req.body.hasOwnProperty('boxing'))
        {
            SportsInterested.push(4); //The code for boxing
        }
        
        if(req.body.hasOwnProperty('taekwondo'))
        {
            SportsInterested.push(5); //The code for taekwondo
        }
        
        if(req.body.hasOwnProperty('basketball'))
        {
            SportsInterested.push(6); //The code for basketball
        }
        
        
        if(req.body.hasOwnProperty('tabletennis'))
        {
            SportsInterested.push(7); //The code for tabletennis
        }
        
        if(req.body.hasOwnProperty('tennis'))
        {
            SportsInterested.push(8); //The code for tennis
        }
        
        if(req.body.hasOwnProperty('volleyball'))
        {
            SportsInterested.push(9); //The code for volleyball
        }
        
        if(req.body.hasOwnProperty('football'))
        {
            SportsInterested.push(10); //The code for football
        }
        
        if(req.body.hasOwnProperty('swimming'))
        {
            SportsInterested.push(11); //The code for swimming
        }

        //Insert all the preferred sports
        for(var i=0; i<SportsInterested.length; i++)
        {
            
            var sql = 'INSERT INTO Interests (userid, sportid) ' + "VALUES($1, $2);";
            Database.query(sql, [result.rows[0].id, SportsInterested[i]], GenericCB, res, req );
        }
        
        //Insert data into the UnreadNotifications table for that userid
        //Initially numfriendreqs, nummessages, numnotifications are all zero
        var sql = 'INSERT INTO UnreadNotifications (userid, numfriendreqs, nummessages, numnotifications) ' + "VALUES($1, 0, 0, 0);";
        Database.query(sql, [result.rows[0].id], GenericCB, res, req );


        //Send it to AJAX
        res.send( "ok" );
    }
    
}


/*****************************************END USER REGISTRATION*****************************************************************/





/*****************************************USER LOGIN*****************************************************************/
//Website User Login
app.post('/WebSiteUserLogin', function(req, res)
                             {
                                 //console.log( req.body );
         
                                 //Server-Side Form Validation (Check if valid user login[email and password])
                                 var sql = 'SELECT * FROM users where (email = $1 and password = $2);';
                                 Database.query(sql, [req.body.email, req.body.password], UserLogin, res, req );
                             }
         );



//Check if email already exists
function UserLogin(err, result,res, req)
{
    
    //The object to contain the ResponseText
    var TheObject = {};
    var JSON2Send = [];
    
    
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    
    //Valid user login
    else if( result.rowCount == 1 )
    {
        console.log('Valid Login');
        
        //Send it to AJAX
        TheObject['ResponseText'] = 'ok';
        JSON2Send.push(TheObject); //The "ResponseText" is always the first object in JSON2Send
        
        //Attach a cookie to the HTTP header to be stored in the browser
        res.cookie( 'UserID' , result.rows[0].id);
        res.cookie( 'UserEmail' , req.body.email);
        res.cookie( 'UserPass' , req.body.password);

        res.setHeader('Access-Control-Allow-Origin', '*');
        //Send JSON File to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
    
    
    //Invalid Login info
    else
    {
        console.log('InValid Login');

        TheObject['ResponseText'] = 'invalidlogin';
        JSON2Send.push(TheObject);
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
    
}

/*****************************************END USER LOGIN*****************************************************************/


/*****************************************FB LOGIN | REGISTRATION*****************************************************************/
require('./passport')(passport);


app.get('/auth/facebook',passport.authenticate('facebook', {scope: ['email']}));

app.get('/auth/facebook/callback',
        passport.authenticate('facebook'),  function(req,res)
                                            {
                                                //Check if user already has an account with this email
                                                var sql = 'SELECT * FROM Users where (email = $1);';
                                                Database.query(sql, [req.user[0].email], FBLoginCB, res, req );
                                            }
       );


//Check if user already has an account with the email retrieved from FB, Don't use the FB ID
//If not, make an account
function FBLoginCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        //error go to home page
        res.redirect('/');
    }
    
    
    //Row (Account) exists
    //Redirect to their profile
    else if( result.rowCount == 1 )
    {
        //Logging in
        //Attach a cookie to the HTTP header to be stored in the browser
        res.cookie( 'UserID' , result.rows[0].id);
        res.cookie( 'UserEmail' , result.rows[0].email);
        res.cookie( 'UserPass' , result.rows[0].password);
        
        res.redirect('/Profile_SelfView.html');
    }
    
    
    //User didn't login with FB before
    //Insert user info (+ email) in db
    else
    {
        //insert in the DB and return the SERIAL EventID (This is concurrent safe)
        var sql = 'INSERT INTO users (first_name, last_name, gender, email, password, fbid, createdAt, ProfileImage) ' + "VALUES($1, $2, $3, $4, $5, $6, now(), './assets/images/DefaultProfilePic.jpg') RETURNING id;";
        //The password and fbid are the same
        Database.query(sql, [req.user[0].firstname, req.user[0].lastname, req.user[0].gender, req.user[0].email, req.user[0].fbid ,req.user[0].fbid], GoToHomePageCB, res, req );
        
    }
    
}


function GoToHomePageCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
        
        //Insert data into the UnreadNotifications table for the new user
        //Initially numfriendreqs, nummessages, numnotifications are all zero
        var sql = 'INSERT INTO UnreadNotifications (userid, numfriendreqs, nummessages, numnotifications) ' + "VALUES($1, 0, 0, 0);";
        Database.query(sql, [result.rows[0].id], GenericCB, res, req );
        
        //Logging in
        //Attach a cookie to the HTTP header to be stored in the browser
        res.cookie( 'UserID' , result.rows[0].id);
        res.cookie( 'UserEmail' , req.user[0].email);
        res.cookie( 'UserPass' , req.user[0].fbid);
        
        //Redirect to their new profile
        res.redirect('/Profile_SelfView.html');
    }
    
}



/*****************************************FB LOGIN | REGISTRATION*****************************************************************/




/*****************************************Get Login User Info*****************************************************************/
app.get('/GetLoginUserInfo', function(req, res)
                             {
                                    //Get all the info that should be displayed when the user logs in:
                                    //Get the path of the user's profile picture in the server
                                    //Get the user's full name profile picture in the server
                                    //Get the UnreadNotifications (numfriendreqs, nummessages, numnotifications)
                                    var sql = "SELECT ProfileImage, first_name||' '||last_name AS username, numfriendreqs, nummessages, numnotifications  FROM (users CROSS JOIN UnreadNotifications) where (id = $1 and password = $2 and users.id = UnreadNotifications.userid);";
        
                                    //Use the cookies
                                    Database.query(sql, [req.cookies.UserID, req.cookies.UserPass], GetLoginUserInfoCB, res, req );
                             }
         );



function GetLoginUserInfoCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //Valid Query but no result found
    else if( result.rowCount == 0 )
    {
        var JSON2Send = [];
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
    
    else
    {
        
        var JSON2Send = [];

        var Object = {};
        Object['ProfileImage'] = result.rows[0].profileimage;
        Object['username'] = result.rows[0].username;
        Object['numfriendreqs'] = result.rows[0].numfriendreqs;
        Object['nummessages'] = result.rows[0].nummessages;
        Object['numnotifications'] = result.rows[0].numnotifications;
        JSON2Send.push(Object);
        
        //res.setHeader('Access-Control-Allow-Origin', '*');
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END Get LoginUser Info*****************************************************************/




/*****************************************Get User's Friends | Event Users*****************************************************************/
//The user wants a list of his/her friends
app.get('/GetUserFriends', function(req, res)
                             {
                                //Extract list of user's friends from the DB with all their info
                                //Status = 1 to make sure friends were approved
                                var sql = "SELECT friend_two, first_name||' '||last_name AS username, ProfileImage  FROM users CROSS JOIN Friends where (friend_one = $1 and id = friend_two and status = 1);";
                                Database.query(sql, [req.cookies.UserID], GetUserFriends_EventUsersCB, res, req );
                             }
         );

//The user wants a list of his/her friends
app.get('/GetDisplayedProfileUserFriends', function(req, res)
                                {
                                //Extract list of user's friends from the DB with all their info
                                //Status = 1 to make sure friends were approved
                                var sql = "SELECT friend_two, first_name||' '||last_name AS username, ProfileImage  FROM users CROSS JOIN Friends where (friend_one = $1 and id = friend_two and status = 1);";
                                Database.query(sql, [req.cookies.FriendIDClicked], GetUserFriends_EventUsersCB, res, req );
                                }
        );

//Get all the users who are attending this event
app.post('/GetEventUsers', function(req, res)
                            {
                            //Get list of the users in the Event and all their info
                            var sql = "SELECT users.id as friend_two, first_name||' '||last_name AS username, ProfileImage, EventRatingSubmitted FROM (users CROSS JOIN EventUsers) where (EventUsers.userid = Users.id and EventUsers.id = $1);";
                            Database.query(sql, [req.body.eventID], GetEventUsersCB, res, req );
                            }
        );



function GetUserFriends_EventUsersCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
 
        //JSON to send back containing all the user's friends info
        var JSON2Send = [];
        
        //Go through all the friends | (events)
        for(var i = 0; i < result.rows.length; i++)
        {
            //Add the object for the user's friend | (user in the event)
            var TheObject = {};
            TheObject['url'] = result.rows[i].profileimage;
            TheObject['name'] = result.rows[i].username;
            TheObject['friendid'] = result.rows[i].friend_two;
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}

function GetEventUsersCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //console.log(result.rows);
        
        //JSON to send back containing all the user's friends info
        var JSON2Send = [];
        
        //Go through all the friends | (events)
        for(var i = 0; i < result.rows.length; i++)
        {
            //Add the object for the user's friend | (user in the event)
            var TheObject = {};
            TheObject['url'] = result.rows[i].profileimage;
            TheObject['name'] = result.rows[i].username;
            TheObject['friendid'] = result.rows[i].friend_two;
            TheObject['EventRatingSubmitted'] = result.rows[i].eventratingsubmitted;
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}

/*****************************************End Get User's Friends| Event Users*****************************************************************/



/*****************************************Get displayed profile Info*****************************************************************/
app.get('/GetDisplayedProfileInfo', function(req, res)
                                    {
                                        //Get all the info that should be displayed when a user visits someone elses profile:
                                        //Get the name and path of the profile picture in the server
                                        var sql = "SELECT ProfileImage, first_name||' '||last_name AS username  FROM users where id = $1;";
        
                                        //Use the "FriendIDClicked" cookies
                                        Database.query(sql, [req.cookies.FriendIDClicked], GetDisplayedProfileInfoCB, res, req );
                                    }
        );



function GetDisplayedProfileInfoCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //Valid Query but no result found
    else if( result.rowCount == 0 )
    {
        var JSON2Send = [];
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
    
    else
    {
        var JSON2Send = [];
        
        var Object = {};
        Object['ProfileImage'] = result.rows[0].profileimage;
        Object['username'] = result.rows[0].username;
        JSON2Send.push(Object);
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}

/*****************************************END Get displayed profile Info*****************************************************************/

/*****************************************GetIsFriendorNot*****************************************************************/
app.get('/GetIsFriendorNot', function(req, res)
                            {
                                //See if the profile we are viewing is our friend or not
                                var sql = "SELECT status, WhoInitiated FROM Friends where (friend_one=$1 and friend_two=$2);";
                                Database.query(sql, [req.cookies.UserID ,req.cookies.FriendIDClicked], GetIsFriendorNotCB, res, req );
                            }
        );



function GetIsFriendorNotCB(err, result,res, req)
{

    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //We are not friends and we haven't added them
    else if(result.rows.length == 0)
    {
        res.send( "notfriend" );
    }
    
    //We are either friends or we added them and are pending
    else
    {
        //We are friends with this user
        if(result.rows[0].status == 1)
        {
            res.send( "yesfriend" );
        }
        
        //Friend Request Pending, we added the profile we are viewing
        else if(result.rows[0].status == 0 && result.rows[0].whoinitiated == req.cookies.UserID)
        {
            res.send( "pendingfriend" );
        }
        
        //Friend Request Pending, we GOT ADDED BY the profile we are viewing
        else if(result.rows[0].status == 0 && result.rows[0].whoinitiated == req.cookies.FriendIDClicked)
        {
            res.send( "ThisUserAddedYou" );
        }

    }
}

/*****************************************END GetIsFriendorNot*****************************************************************/


/*****************************************Upload Profile pic*****************************************************************/
app.post('/UploadProfilePic', function(req,res)
                            {
         
                               var fstream;
                               req.pipe(req.busboy);
                               req.busboy.on('file',   function (fieldname, file, filename, encoding, mimetype)
                                                       {
                                                            //console.log("Uploading: " + filename);
                                                            //console.log('file type: ' + mimetype);
                                             
                                                             //Only accept jpg files, if not jpg don't upload
                                                             if( mimetype != 'image/jpg' && mimetype != 'image/jpeg')
                                                             {
                                                                file.resume();
                                                             }
                                                             
                                                             else
                                                             {
                                                                //Path where image will be uploaded
                                                                //For the file name use the user's unique ID (So if re-uplooad, it'll overwrite the image)
                                                               var UploadedImagePath = '/front_end/assets/images/' + req.cookies.UserID + ".jpg";
                                             
                                                               fstream = fs.createWriteStream(__dirname + UploadedImagePath);
                                                               file.pipe(fstream);
                                                               fstream.on('close', function ()
                                                                                  {
                                                                                    //Update the path of the user's profile pic in the database
                                                                                    var sql = "UPDATE users SET ProfileImage = $1 WHERE id = $2;";

                                                                                    //Use the "UserID" cookies
                                                                                    Database.query(sql, ['./assets/images/' + req.cookies.UserID + '.jpg' , req.cookies.UserID], RefreshPageCB, res, req );
                                                                          
                                                                                    //console.log("Upload Finished of " + filename);
                                                                                  }
                                                                        );
                                                             }
                                                       }
                                           );

                            }
        );


function RefreshPageCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
        res.redirect('/Profile_SelfView.html');   //Refresh your profile page
    }
    
}
/*****************************************End Upload Profile pic*****************************************************************/


/*****************************************CREATE NEW EVENT*****************************************************************/
app.post('/CreateNewEvent', function(req, res)
                             {
                                //console.log( req.body );

                                //First Find the sportid of this event
                                var sql = 'SELECT sportid FROM Sports where (name = $1);';
                                Database.query(sql, [req.body.EventType.toLowerCase()], GetSportIDCB, res, req );

                             }
         );


//Find the sportid of this event
function GetSportIDCB(err, result,res, req)
{
    
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //Now insert this new event in the DB "Event"
    else
    {
        //console.log(result.rows[0].sportid);
    
        //Attendance is initially one (The admin)
        //Insert and return the SERIAL EventID (This is concurrent safe)
        var sql = 'INSERT INTO Event (name, location, numppl, attendance, DateTime, EndTime, Description, EventType, EventTypeID, EventAdminID) ' + "VALUES($1, $2, $3, 1, $4, $5, $6, $7, $8, $9) RETURNING Eventid;";
        Database.query(sql, [req.body.EventName, req.body.EventLocation, req.body.EventNumppl, req.body.EventDateTime, req.body.EventEndTime, req.body.EventDescription, req.body.EventType.toLowerCase(), result.rows[0].sportid, req.cookies.UserID], CreateEventCB, res, req );
    }
    
}


function CreateEventCB(err, result,res, req)
{
    
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    

    //Now insert this user (The admin) as a person who is attending the event
    else
    {
        //Use the EventID SERIALized for this event by the server
        var sql = 'INSERT INTO EventUsers (id, userid) ' + "VALUES($1, $2);";
        Database.query(sql, [result.rows[0].eventid, req.cookies.UserID], EventCreatedCB, res, req );
    }
    
}



function EventCreatedCB(err, result,res, req)
{
    
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }

    else
    {
        //Reload Self Profile Page
        //To show the calendar SVG with a tick sign
        res.redirect('/Profile_SelfView.html?EventSuccess=yes');
    }
    
}
/*****************************************END CREATE NEW EVENT*****************************************************************/



/*****************************************View Events*****************************************************************/
app.get('/ViewEvents', function(req, res)
                     {
    
                        var sql = "SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, (EXTRACT(EPOCH FROM EndTime::Time - DateTime::Time)/3600)||' Hours' AS Duration, to_char(EndTime, 'HH:MI AM') AS EventEndTime, location, Description, numppl, (numppl - attendance) AS EventNumSpotsLeft, ProfileImage AS EventAdminPic, first_name||' '||last_name AS EventAdminName, (datetime::date||' '||endtime)::timestamp AS CompleteEndTime FROM (Event CROSS JOIN EventUsers CROSS JOIN Users) where (userid = $1 and EventUsers.id = Eventid and userid = Users.id and email = $2) ORDER BY DateTime DESC;";
                        
                        //Use the cookies
                        Database.query(sql, [req.cookies.UserID, req.cookies.UserEmail], SendUserEventsCB, res, req );
    
                     }
         );


function SendUserEventsCB(err, result,res, req)
{
    
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //Send the Events as a JSON file
    else
    {
        //console.log(result.rows);
        
        var JSON2Send = [];
        
        //Go through all the Events
        for(var i = 0; i < result.rows.length; i++)
        {
            
            //Each object represents all the info needed for one event
            var TheObject = {};
            TheObject['EventName'] = result.rows[i].name;
            TheObject['EventType'] = result.rows[i].eventtype;
            TheObject['EventDateTime'] = result.rows[i].eventdatetime;
            TheObject['Duration'] = result.rows[i].duration;
            TheObject['EventEndTime'] = result.rows[i].eventendtime;
            TheObject['EventLocation'] = result.rows[i].location;
            TheObject['EventDescription'] = result.rows[i].description;
            TheObject['EventNumPpl'] = result.rows[i].numppl;
            TheObject['EventNumSpotsLeft'] = result.rows[i].eventnumspotsleft;
            TheObject['EventID'] = result.rows[i].eventid;
            TheObject['EventAdminPic'] = result.rows[i].eventadminpic;
            TheObject['EventAdminName'] = result.rows[i].eventadminname;
            TheObject['CompleteEndTime'] = result.rows[i].completeendtime;
            
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );

    }
}

/*****************************************END View Events*****************************************************************/


/*****************************************Leave Event*****************************************************************/
app.post('/LeaveEvent', function(req, res)
                        {
                            //Sent by AJAX as a JSON File
                            //console.log(req.body.eventID);
                        
                            //Check if this user(who is leaving) was the admin of the event
         
                            var sql = "SELECT * FROM Event where (Eventid = $1 and EventAdminID=$2);";
                            Database.query(sql, [req.body.eventID, req.cookies.UserID], IsAdminLeaveEventCB, res, req );

                        }
        );



//If an admin leaves his own event, the whole event is cancelled
function IsAdminLeaveEventCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //User who is leaving the event is the admin
    else if(result.rowCount == 1)
    {
        //Remove the whole event from Table "Event"
        //Changes are propagated by "On Delete Cascade"
        var sql = "DELETE FROM Event where (Eventid = $1 and EventAdminID = $2);";
        Database.query(sql, [req.body.eventID, req.cookies.UserID], GenericCB, res, req );
        
        //Tell AJAX to pop up an alert box
        res.send( "UserWasAdmin" );
    }
    
    //User who is leaving is not the admin
    else
    {
        //Remove the user from Table "EventUsers"
        var sql = "DELETE FROM EventUsers where (id = $1 and userid = $2);";
        Database.query(sql, [req.body.eventID, req.cookies.UserID], GenericCB, res, req );
        
        //Decrease the attendance by 1
        var sql = "UPDATE Event SET attendance = (attendance-1) where eventid = $1;";
        Database.query(sql, [req.body.eventID], GenericCB, res, req );
        
        res.send( "" );
    }
    
}
/*****************************************END Leave Event*****************************************************************/



/*****************************************GetEventMessages*****************************************************************/
app.post('/GetEventMessages', function(req, res)
                             {
                                //Get all the messages in the group chat for that event
                                var sql = "SELECT sentById, ProfileImage, chatmessage FROM (EventGroupChat CROSS JOIN users) where (sentById = Users.id and eventid = $1) order by MessageTime ASC;";
                                Database.query(sql, [req.body.eventID], GetEventMessagesCB, res, req );
                             }
         );


function GetEventMessagesCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        
        //JSON to send back containing the event messages
        var JSON2Send = [];
        
        //Go through all messages
        for(var i = 0; i < result.rows.length; i++)
        {
            var TheObject = {};
            TheObject['sentById'] = result.rows[i].sentbyid;
            TheObject['ProfileImage'] = result.rows[i].profileimage;
            TheObject['chatmessage'] = result.rows[i].chatmessage;
            JSON2Send.push(TheObject);
            
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}
/*****************************************END GetEventMessages*****************************************************************/




/*****************************************GetAboutUserInfo - Paul*****************************************************************/
app.get('/GetUserAboutInfo', function(req, res) {
        //Get all the info that should be displayed when the user logs in:
        //Get the path of the user's profile picture in the server
        //Get the user's full name profile picture in the server
        var sql = "SELECT campus, first_name, last_name, phone, email, to_char(birthday, 'YYYY-MM-DD') AS Birthday, height, weight, gender, about, Sports.name  FROM (users CROSS JOIN Interests CROSS JOIN Sports) where (Interests.sportid = Sports.sportid and id=$1 and id = Interests.userid);";
        
        //pass normal userid to function when clicking "about" on selfview.
        var userID_Pass = [req.cookies.UserID];
        
        //pass FriendID to function when clicking "about" on Otherview.
        if (req.cookies.FriendIDClicked !== undefined)
        {
        userID_Pass = [req.cookies.FriendIDClicked];
        }
        
        //Use the cookies
        Database.query(sql, userID_Pass, GetUserAboutInfoCB, res, req );
        });


function GetUserAboutInfoCB(err, result,res, req)
{
    //handle error
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //If the user doesn't have any interested sports, then just request for other infos (all except for sports).
        if (result.rows.length === 0)
        {
            var sql = "SELECT campus, first_name, last_name, phone, email, to_char(birthday, 'YYYY-MM-DD') AS Birthday, height, weight, gender, about FROM Users WHERE id=$1;";
            
            //pass normal userid to function when clicking "about" on selfview.
            var userID_Pass = [req.cookies.UserID];
            
            //pass FriendID to function when clicking "about" on Otherview.
            if (req.cookies.FriendIDClicked !== undefined)
            {
                userID_Pass = [req.cookies.FriendIDClicked];
            }
            
            Database.query(sql, userID_Pass, GetUserAboutInfo_NoSports, res, req );
        }
        else
        {
            //Send json file to the front-end to display
            sendUserInfoJSON(result, res);
        }
    }
}

//when the user doesn't specify interested sports, then just get other infos.
function GetUserAboutInfo_NoSports(err, result, res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
        sendUserInfoJSON(result, res);
    }
}

function sendUserInfoJSON(result, res)
{
    var JSON2Send = [];
    
    //put in
    var Object = {};
    Object['Campus'] = result.rows[0].campus;
    Object['First_Name'] = result.rows[0].first_name;
    Object['Last_Name'] = result.rows[0].last_name;
    Object['Phone_number'] = result.rows[0].phone;
    Object['Email_Address'] = result.rows[0].email;
    Object['Birthday'] = result.rows[0].birthday;
    Object['Height'] = result.rows[0].height;
    Object['Weight'] = result.rows[0].weight;
    Object['Gender'] = result.rows[0].gender;
    Object['About_Me'] = result.rows[0].about;
    if (result.rows[0].about === null)
    {
        Object['About_Me'] = "";
    }
    
    //List of user's sports interest they chose
    var SportsInterested = [];
    
    //Go through all Interested Sports
    for(var i = 0; i < result.rows.length; i++)
    {
        SportsInterested.push(result.rows[i].name);	
    }
    
    Object['SportsInterested'] = SportsInterested;
    JSON2Send.push(Object);
    
    //Send it to AJAX
    res.end( JSON.stringify(JSON2Send) );
}
/*****************************************END GetAboutUserInfo Paul*****************************************************************/



/*****************************************UpdateAboutUserInfo - Paul*****************************************************************/
app.post('/updateUserInfo', function(req, res){
         var userInfo = [];
         userInfo.push(req.body.Birthday);
         userInfo.push(req.body.Height);
         userInfo.push(req.body.Weight);
         userInfo.push(req.body.Phone_number);
         userInfo.push(req.body.campus);
         userInfo.push(req.body.About_Me);
         userInfo.push(req.cookies.UserID);
         
         interested = getUserInterest(req);
         
         var query = "UPDATE Users SET birthday = $1, height = $2, weight = $3, phone = $4, campus = $5, about = $6 WHERE users.id = $7;"
         
         //update user info
         Database.query(query, userInfo, GenericCB, res, req);
         
         var deleteUserInterest ='DELETE FROM interests WHERE userid = $1;';
         
         //delete the interest
         Database.query(deleteUserInterest, [req.cookies.UserID], update, res, req);
         //add new interest
         });

function update(err, result, res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
        
        var SportsInterested = getUserInterest(req);
        
        //insert new interests into interest table.
        for(var i=0; i < SportsInterested.length; i++)
        {
            var sql = 'INSERT INTO Interests (userid, sportid) ' + "VALUES($1, $2);";
            Database.query(sql, [req.cookies.UserID, SportsInterested[i]], GenericCB, res, req);
        }
        
        res.end(JSON.stringify([]));
    }
}

function getUserInterest(req){
    
    var SportsInterested = [];
    if(req.body.hasOwnProperty('cycling'))
    {
        SportsInterested.push(1); //The code for cycling
    }
    
    if(req.body.hasOwnProperty('waterpolo'))
    {
        SportsInterested.push(2); //The code for waterpolo
    }
    
    if(req.body.hasOwnProperty('squash'))
    {
        SportsInterested.push(3); //The code for squash
    }
    
    if(req.body.hasOwnProperty('boxing'))
    {
        SportsInterested.push(4); //The code for boxing
    }
    
    if(req.body.hasOwnProperty('taekwondo'))
    {
        SportsInterested.push(5); //The code for taekwondo
    }
    
    if(req.body.hasOwnProperty('basketball'))
    {
        SportsInterested.push(6); //The code for basketball
    }
    
    
    if(req.body.hasOwnProperty('tabletennis'))
    {
        SportsInterested.push(7); //The code for tabletennis
    }
    
    if(req.body.hasOwnProperty('tennis'))
    {
        SportsInterested.push(8); //The code for tennis
    }
    
    if(req.body.hasOwnProperty('volleyball'))
    {
        SportsInterested.push(9); //The code for volleyball
    }
    
    if(req.body.hasOwnProperty('football'))
    {
        SportsInterested.push(10); //The code for football
    }
    
    if(req.body.hasOwnProperty('swimming'))
    {
        SportsInterested.push(11); //The code for swimming
    }
    return SportsInterested;
}
/*****************************************END UpdateAboutUserInfo Paul*****************************************************************/

/***********************************Paul SELFVIEW: CHANGE PASSWORD ********************************/
app.post('/ChangePassword', function(req,res){
         var sql = 'SELECT id, password FROM Users where (id = $1);';
         Database.query(sql, [req.cookies.UserID], ChangePassword, res, req );
         });

function ChangePassword(err, result, res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
        //console.log(req);
        //console.log(result);
        
        //set status to success initially.
        var stat = {"status":0};
        
        if (req.body.newPass !== req.body.confirmNewPass)
        {
            //send status -1 (fails to confirm new password).
            stat.status = -1;
            res.end(JSON.stringify(stat));
        }
        else if (req.body.currentPass !== result.rows[0].password)
        {
            //send status -2 (fails to confirm current password).
            stat.status = -2;
            res.end(JSON.stringify(stat));
        }
        else
        {
            //send status 0 (success to change password)
            
            /***********/
            var sql = "UPDATE Users SET password = $1,hashedpassword = $2 WHERE id = $3";
            var hashedpassword = bcrypt.hashSync(req.body.newPass);
            Database.query(sql, [req.body.newPass, hashedpassword,result.rows[0].id], GenericCB, res, req );
            /************/
            
            //update cookies.UserPass to new password.
            res.cookie( 'UserPass' , req.body.newPass);
            
            res.end(JSON.stringify(stat));
        }
    }
}
/***********************************Paul END SELFVIEW: CHANGE PASSWORD ****************************/





/*****************************************SearchEventsByClick | Typing*****************************************************************/
//User is searching for events
//Send back data to show preview of events matching their search
app.post('/SearchEventsByClick', function(req, res)
                            {
             
                                //Select all events that match the sport selected and that ((numppl - attendance) > 0) [the event has open spots]
                                //And subtract it from events in which you are already joined in
                                var sql = "(SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, numppl, (numppl - attendance) AS EventNumSpotsLeft FROM Event where (EventType = $1 and ((numppl - attendance) > 0))) EXCEPT (SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, numppl, (numppl - attendance) AS EventNumSpotsLeft FROM (Event CROSS JOIN EventUsers CROSS JOIN Users) where (userid = $2 and EventUsers.id = Eventid and userid = Users.id) );";

                                Database.query(sql, [req.body.EventSportClicked, req.cookies.UserID], GetEventsSelectedSportSearchCB, res, req );
                            }
  
        );

//User sends the SearchString
app.post('/SearchEventsByTyping', function(req, res)
                                 {
                                     //Convert EventType and name to lower case to match with the lowercase SearchString
                                     //SearchString can be an event name or an event sport type
                                     //Select all events that match and that ((numppl - attendance) > 0) [the event has open spots]
                                     //And subtract it from events in which you are already joined in
                                     var sql = "(SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, numppl, (numppl - attendance) AS EventNumSpotsLeft FROM Event where (((lower(EventType) LIKE $1) or (lower(name) LIKE $1)) and ((numppl - attendance) > 0))) EXCEPT (SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, numppl, (numppl - attendance) AS EventNumSpotsLeft FROM (Event CROSS JOIN EventUsers CROSS JOIN Users) where (userid = $2 and EventUsers.id = Eventid and userid = Users.id) );";
                                     Database.query(sql, ['%' + req.body.SearchString + '%', req.cookies.UserID], GetEventsSelectedSportSearchCB, res, req );
                                 }
         
         );



function GetEventsSelectedSportSearchCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        
        var JSON2Send = [];

        //Go through all the Events
        for(var i = 0; i < result.rows.length; i++)
        {
            //Each object represents all the info needed for one event
            var TheObject = {};
            TheObject['EventName'] = result.rows[i].name;
            TheObject['EventID'] = result.rows[i].eventid;
            TheObject['EventType'] = result.rows[i].eventtype;
            TheObject['EventDateTime'] = result.rows[i].eventdatetime;
            TheObject['EventNumPpl'] = result.rows[i].numppl;
            TheObject['EventNumSpotsLeft'] = result.rows[i].eventnumspotsleft;

            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END SearchEventsByClick | Typing*****************************************************************/

/*****************************************SearchEventsMoreDetail*****************************************************************/
//User is searching for events
//Send back data to show preview of events matching their search
app.post('/SearchEventsMoreDetail', function(req, res)
                             {
         
                 var sql = "SELECT Eventid, name, EventType, to_char(DateTime, 'DD Mon YYYY HH:MI AM') AS EventDateTime, (EXTRACT(EPOCH FROM EndTime::Time - DateTime::Time)/3600)||' Hours' AS Duration, to_char(EndTime, 'HH:MI AM') AS EventEndTime, location, Description, numppl, (numppl - attendance) AS EventNumSpotsLeft, ProfileImage AS EventAdminPic, first_name||' '||last_name AS EventAdminName FROM (Event CROSS JOIN Users) where (Eventid = $1 and EventAdminID = Users.id);";
         
                             Database.query(sql, [req.body.EventClicked], SendUserEventsCB, res, req );
         
                             }
         
         );

/*****************************************END SearchEventsMoreDetail*****************************************************************/


/*****************************************JoinEvent*****************************************************************/
//User is searching for events
//Send back data to show preview of events matching their search
app.post('/JoinEvent', function(req, res)
         {
         
         //console.log('gna join event: ' + req.cookies.UserID + ' event to join: ' + req.body.EventToJoin);
         
             var sql1 = 'INSERT INTO EventUsers (id, userid) ' + "VALUES($1, $2);";
             Database.query(sql1, [req.body.EventToJoin, req.cookies.UserID], JoinEventCB, res, req );
         }
         
         );

function JoinEventCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //Increase the attendance by 1
        var sql = "UPDATE Event SET attendance = (attendance+1) where eventid = $1;";
        Database.query(sql, [req.body.EventToJoin], GenericCB, res, req );
        res.send("");
    }
}
/*****************************************END JoinEvent*****************************************************************/


/*****************************************SearchUser*****************************************************************/
//Searching for a user
app.post('/SearchUsers', function(req, res)
         {
             //Convert all names to lowercase for matching
             //Select all matching users and don't include the user himself
             var sql = "SELECT id, first_name||' '||last_name AS name, ProfileImage FROM Users where ((lower(first_name||' '||last_name) LIKE $1) and (id <> $2)) ;";
             Database.query(sql, ['%' + req.body.SearchUserString + '%', req.cookies.UserID], SearchUsersCB, res, req );
         }
         
         );



function SearchUsersCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        var JSON2Send = [];
        
        //Go through all the Users matched
        for(var i = 0; i < result.rows.length; i++)
        {
            //Each object represents all the info needed for one user
            var TheObject = {};
            TheObject['url'] = result.rows[i].profileimage;
            TheObject['name'] = result.rows[i].name;
            TheObject['userid'] = result.rows[i].id;
            
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END SearchUser*****************************************************************/


/*****************************************GetFriendRequests*****************************************************************/
app.get('/GetFriendRequests', function(req, res)
            {
                //Update UnreadNotifications table
                //Since we clicked on the friend request icon, our UNREAD numfriendreqs becomes 0
                var sql = "UPDATE UnreadNotifications SET numfriendreqs = 0 where userid = $1;";
                Database.query(sql, [req.cookies.UserID], GenericCB, res, req );
        
                //Get all your friend requests and their picture and name
                var sql = "SELECT Users.id, ProfileImage, first_name||' '||last_name AS name FROM (Users CROSS JOIN Friends) where (friend_one = $1 and Users.id=friend_two and status=0 and WhoInitiated<>$1);";
                
                //Use the cookies
                Database.query(sql, [req.cookies.UserID], GetFriendRequestsCB, res, req );
            }
        );


function GetFriendRequestsCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    //No Friend Reqs
    else if(result.rows.length == 0)
    {
        var JSON2Send = [];
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
    
    else
    {
        //console.log(result.rows);
        
        var JSON2Send = [];
        
        //Go through all the Users matched
        for(var i = 0; i < result.rows.length; i++)
        {
            //Each object represents all the info needed for one user
            var TheObject = {};
            TheObject['url'] = result.rows[i].profileimage;
            TheObject['name'] = result.rows[i].name;
            TheObject['userid'] = result.rows[i].id;
            
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END GetFriendRequests*****************************************************************/


/*****************************************Accept | Reject FriendReqs*****************************************************************/
//Accepting a friend
app.post('/FriendAccepted', function(req, res)
         {
             //Friend Accepted, update the 2 rows relating to these 2 new friends
             var sql = "UPDATE Friends SET status=1 where ((friend_one=$1 and friend_two=$2) or (friend_one=$2 and friend_two=$1));";
             Database.query(sql, [req.cookies.UserID, req.body.friendidaccepted], Accept_RejectFriendCB, res, req );
         }
         
         );

//Rejecting a friend
app.post('/FriendRejected', function(req, res)
         {
         //Friend Accepted, update the 2 rows relating to these 2 new friends
         var sql = "DELETE FROM Friends WHERE ((friend_one=$1 and friend_two=$2) or (friend_one=$2 and friend_two=$1));";
         Database.query(sql, [req.cookies.UserID, req.body.friendidrejected], Accept_RejectFriendCB, res, req );
         }
         
         );


function Accept_RejectFriendCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    else
    {
       res.send("");
    }
}
/*****************************************END Accept | Reject FriendReqs*****************************************************************/


/*****************************************GetMessageHistoryWithUser*****************************************************************/
app.post('/GetMessageHistoryWithUser', function(req, res)
                                    {
                                        //Get all the messages we exchanges with this user
                                        var sql = "SELECT sentById, chatmessage FROM OneToOneChat where ((sentById = $1 and ReceivedById=$2) or (sentById = $2 and ReceivedById=$1)) order by MessageTime ASC;";
                                        Database.query(sql, [req.cookies.UserID, req.body.Chattingtoid], GetMessageHistoryWithUserCB, res, req );
                                    }
       );


function GetMessageHistoryWithUserCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        
        //JSON to send back containing the event messages
        var JSON2Send = [];
        
        //Go through all messages
        for(var i = 0; i < result.rows.length; i++)
        {
            var TheObject = {};
            TheObject['sentById'] = result.rows[i].sentbyid;
            TheObject['chatmessage'] = result.rows[i].chatmessage;
            JSON2Send.push(TheObject);
            
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}
/*****************************************END GetMessageHistoryWithUser*****************************************************************/


/*****************************************Get GetListPplMessaged*****************************************************************/
app.get('/GetListPplMessaged', function(req, res)
        {

        //Since we clicked on the messages icon, our UNREAD nummessages becomes 0
        var sql = "UPDATE UnreadNotifications SET nummessages = 0 where userid = $1;";
        Database.query(sql, [req.cookies.UserID], GenericCB, res, req );
        
        //For each person we have ever messaged, get their id, their fullname, their picture, our LATEST chatmessage with them, and the MessageTime
        //Order by MessageTime DESC
        var sql = "SELECT id, first_name||' '||last_name AS NameChattingTo, ProfileImage, chatmessage "+
                  "FROM (Users CROSS JOIN " +
                                          "( " +
                                              "SELECT sentById, ReceivedById, chatmessage, MessageTime " +
                                              "FROM OneToOneChat chat1 " +
                                              "WHERE ( " +
                                                        "(chat1.sentById=$1 or chat1.ReceivedById=$1) " +
                                                        "and " +
                                                        "(NOT EXISTS " +
                                                                "(SELECT chat2.MessageTime " +
                                                                "FROM OneToOneChat chat2 " +
                                                                "WHERE (" +
                                                                      "( (chat1.sentById=chat2.sentById and chat1.ReceivedById=chat2.ReceivedById) or (chat1.ReceivedById=chat2.sentById and chat1.sentById=chat2.ReceivedById) ) " +
                                                                         "and (chat2.MessageTime > chat1.MessageTime) " +
                                                                      ")" +
                                                                ")" +
                                                         ") " +
                                                    ") " +
                                          ") AS OneMessagePerUser" +
                        ") " +
                "WHERE ((Users.id <> $1) and (id=sentById or id=ReceivedById)) " +
                "order by MessageTime DESC ;" ;
        
        //Use the cookies
        Database.query(sql, [req.cookies.UserID], GetListPplMessagedCB, res, req );
        }
        );


function GetListPplMessagedCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }

    
    else
    {
        //console.log(result.rows);
        
        var JSON2Send = [];
        
        //Go through list of people messaged
        for(var i = 0; i < result.rows.length; i++)
        {
            //Each object is the latest messaged we exchanged with that user
            var TheObject = {};
            TheObject['url'] = result.rows[i].profileimage;
            TheObject['name'] = result.rows[i].namechattingto;
            TheObject['userid'] = result.rows[i].id;
            TheObject['chatmessage'] = result.rows[i].chatmessage;
            
            JSON2Send.push(TheObject);
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END GetListPplMessaged*****************************************************************/



/*****************************************SubmitEventRatings*****************************************************************/
app.post('/SubmitEventRatings', function(req, res)
                                {
                                      //console.log(req.body);
         
                                     //Update the EventUsers table, the ratings for this event have been submitted
                                     var sql = "UPDATE EventUsers SET EventRatingSubmitted = 'yes' where (id = $1 and userid=$2);";
                                     Database.query(sql, [req.body.EventID_RatingsSubmitted, req.cookies.UserID], SubmitRatingsCB, res, req );
                                }
        );


function SubmitRatingsCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        
        //Only one user was rated
        if( req.body.EventUserID.length == 1 )
        {
            
            //If the rating value is 0, that means the user was not rated, so don't insert
            if(req.body.ratingvalue != 0)
            {
                var sql = 'INSERT INTO Ratings (userid, eventid, comment, rating) ' + "VALUES($1, $2, $3, $4);";
                Database.query(sql, [req.body.EventUserID, req.body.EventID_RatingsSubmitted, req.body.EventRatingComments, req.body.ratingvalue], GenericCB, res, req );
            }
        }
        
        
        //Multiple users were rated
        else
        {
            //Go through all the users in this event who were rated
            for(var i = 0; i < req.body.EventUserID.length; i++)
            {
                
                //If the rating value is 0, that means the user was not rated, so don't insert
                if(req.body.ratingvalue[i] != 0)
                {
                    var sql = 'INSERT INTO Ratings (userid, eventid, comment, rating) ' + "VALUES($1, $2, $3, $4);";
                    Database.query(sql, [req.body.EventUserID[i], req.body.EventID_RatingsSubmitted, req.body.EventRatingComments[i], req.body.ratingvalue[i]], GenericCB, res, req );
                }
            }
        }
        
        
        res.redirect('/Profile_SelfView.html');
    }
}
/*****************************************END SubmitEventRatings*****************************************************************/



/*****************************************GetAllSports*****************************************************************/
app.get('/GetAllSports', function(req, res)
                         {
                            //Get all the sports available
                            var sql = "SELECT DISTINCT name AS EventType FROM Sports;";
                            Database.query(sql, [], GetAllSportsCB, res, req );
                         }
       );


function GetAllSportsCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //console.log(result.rows);
        
        //JSON to send back
        var JSON2Send = [];

        //Go through all the event sport types attended
        for(var i = 0; i < result.rows.length; i++)
        {
            var TheObject = {};
            TheObject['SportType'] = result.rows[i].eventtype;
            JSON2Send.push(TheObject);
            
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}
/*****************************************END GetAllSports*****************************************************************/


/*****************************************GetSportsAttended*****************************************************************/
app.get('/GetSportsAttended', function(req, res)
                            {
                                //Get all the distinct event types and their type ID the user attended and was rated in
                                var sql = "SELECT DISTINCT EventType, EventTypeID FROM (Ratings CROSS JOIN Event) where (userid=$1 and Ratings.eventid=Event.Eventid) ;";
                                Database.query(sql, [req.cookies.UserID], GetSportsAttendedCB, res, req );
                            }
        );

app.get('/GetFriendSportsAttended', function(req, res)
                                    {
                                        //Get all the distinct event types and their type ID the user attended and was rated in
                                        var sql = "SELECT DISTINCT EventType, EventTypeID FROM (Ratings CROSS JOIN Event) where (userid=$1 and Ratings.eventid=Event.Eventid) ;";
                                        Database.query(sql, [req.cookies.FriendIDClicked], GetSportsAttendedCB, res, req );
                                    }
        );


function GetSportsAttendedCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //console.log(result.rows);
        
        //JSON to send back
        var JSON2Send = [];
        
        //Go through all the event sport types attended
        for(var i = 0; i < result.rows.length; i++)
        {
            var TheObject = {};
            TheObject['SportType'] = result.rows[i].eventtype;
            TheObject['SportTypeID'] = result.rows[i].eventtypeid;
            JSON2Send.push(TheObject);
            
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
        
    }
}
/*****************************************END GetSportsAttended*****************************************************************/



/*****************************************GetUserReviews*****************************************************************/
app.post('/GetUserReviews', function(req, res)
                        {
                            //Get the user's average rating in this sport
                            //Sport ID clicked is sent to server by AJAX
                            var sql = "SELECT round(sum(rating)/count(rating)) AS SportRating FROM (Ratings CROSS JOIN Event) WHERE (userid=$1 and Ratings.eventid=Event.Eventid and EventTypeID=$2);";
                            Database.query(sql, [req.cookies.UserID, req.body.SportID], GetUserRatingCB, res, req );
                        }
        );


function GetUserRatingCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //JSON to send back
        var JSON2Send = [];
        var TheObject = {};
        TheObject['SportRating'] = result.rows[0].sportrating;
        JSON2Send.push(TheObject);
        
        //Get a list of all reviews of the user in this sport ID
        var sql = "SELECT comment,  to_char(ratingDateTime, 'DD Mon YYYY') AS CommentDate FROM (Ratings CROSS JOIN Event) WHERE (userid=$1 and Ratings.eventid=Event.Eventid and EventTypeID=$2) ORDER BY ratingDateTime DESC;";
        //Pass the JSON to next CB function to send, instead of req cuz we dont need req anymore
        Database.query(sql, [req.cookies.UserID, req.body.SportID], GetUserReviewsCB, res, JSON2Send );
    }
}

function GetUserReviewsCB(err, result,res, JSON2Send)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
                //Go through all the Reviews
                for(var i = 0; i < result.rows.length; i++)
                {
                    //Don't enter the review if the comment is empty!
                    if( result.rows[i].comment.length > 0 )
                    {
                        var TheObject = {};
                        TheObject['Comment'] = result.rows[i].comment;
                        TheObject['CommentDate'] = result.rows[i].commentdate;
                        JSON2Send.push(TheObject);
                    }
        
                }
        
                //Send it to AJAX
                res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END GetUserReviews*****************************************************************/


/*****************************************GetFriendUserReviews*****************************************************************/
app.post('/GetFriendUserReviews', function(req, res)
                                 {
                                 //Get the user's average rating in this sport
                                 //Sport ID clicked is sent to server by AJAX
                                 var sql = "SELECT round(sum(rating)/count(rating)) AS SportRating FROM (Ratings CROSS JOIN Event) WHERE (userid=$1 and Ratings.eventid=Event.Eventid and EventTypeID=$2);";
                                 Database.query(sql, [req.cookies.FriendIDClicked, req.body.SportID], GetFriendUserRatingCB, res, req );
                                 }
         );


function GetFriendUserRatingCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //JSON to send back
        var JSON2Send = [];
        var TheObject = {};
        TheObject['SportRating'] = result.rows[0].sportrating;
        JSON2Send.push(TheObject);
        
        //Get a list of all reviews of the user in this sport ID
        var sql = "SELECT comment,  to_char(ratingDateTime, 'DD Mon YYYY') AS CommentDate FROM (Ratings CROSS JOIN Event) WHERE (userid=$1 and Ratings.eventid=Event.Eventid and EventTypeID=$2) ORDER BY ratingDateTime DESC;";
        //Pass the JSON to next CB function to send, instead of req cuz we dont need req anymore
        Database.query(sql, [req.cookies.FriendIDClicked, req.body.SportID], GetFriendUserReviewsCB, res, JSON2Send );
    }
}

function GetFriendUserReviewsCB(err, result,res, JSON2Send)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    
    else
    {
        //Go through all the Reviews
        for(var i = 0; i < result.rows.length; i++)
        {
            //Don't enter the review if the comment is empty!
            if( result.rows[i].comment.length > 0 )
            {
                var TheObject = {};
                TheObject['Comment'] = result.rows[i].comment;
                TheObject['CommentDate'] = result.rows[i].commentdate;
                JSON2Send.push(TheObject);
            }
            
        }
        
        //Send it to AJAX
        res.end( JSON.stringify(JSON2Send) );
    }
}
/*****************************************END GetFriendUserReviews*****************************************************************/



/*****************************************WasUserLoggedIn*****************************************************************/
app.get('/WasUserLoggedIn', function(req, res)
                            {
                                //No cookies exists
                                if( req.cookies.UserID == undefined && req.cookies.UserPass == undefined)
                                {
                                    res.send("notloggedin");
                                }
                                
                                //There are cookies, check if the cookies are valid
                                else
                                {
                                    var sql = 'SELECT * FROM users where (id = $1 and password = $2);';
                                    Database.query(sql, [req.cookies.UserID, req.cookies.UserPass], WasUserLoggedInCB, res, req );
                                }
        
                            }
        );


function WasUserLoggedInCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        res.send("Error " + err);
    }
    

    //Valid user login
    else if( result.rowCount == 1 )
    {
        res.send("userwasloggedin");
    }
    
    
    //Invalid Login info
    else
    {
        res.send("notloggedin");
    }
    
}
/*****************************************END WasUserLoggedIn*****************************************************************/

















/*****************************************Start Admin Jim*****************************************************************/

app.get('/admin', function (req, res)
                {
                res.sendFile(__dirname + '/front_end/admin_login.html');
                }
        );

app.post('/WebsiteAdminLogin',function(req,res)
         {
         var sql = 'SELECT * FROM admins WHERE account = $1 and password = $2';
         Database.query(sql,[req.body.account,req.body.password],AdminLoginCB,res,req);
         });

function AdminLoginCB(err,result,res,req){
    if(err){
        console.log(err);
        res.send(err);
    }
    else if(result.rowCount == 1){
        //find the admin account&password from the db
        //add a cookie to http header to store admin's name
        res.cookie( 'AdminName' , result.rows[0].name);
        res.send("ok");
        
    }else{
        //not found
        res.send("loginfailed");
    }
}

app.get('/getAllUsersInfo',function(req,res){
        var sql = 'SELECT * FROM users';
        Database.query(sql,[],GetAllUsersCB,res,req);
        });

function GetAllUsersCB(err,result,res,req){
    var JSON2Send = [];
    //console.log(result);
    if(err){
        console.log(err);
        res.send(err);
    }
    else if(result.rowCount == 0){
        //no users in the table
        res.end(JSON.stringify(JSON2Send));
    }else{
        //at least one user in the table
        var len = result.rowCount;
        for(var i = 0;i < len;i++){
            var Object = {};
            Object.first_name = result.rows[i].first_name;
            Object.last_name = result.rows[i].last_name;
            if(result.rows[i].birthday != null){
                //convert date to year/month/day format
                var date = '';
                var month = result.rows[i].birthday.getUTCMonth() + 1;
                var day = result.rows[i].birthday.getUTCDate();
                var year = result.rows[i].birthday.getUTCFullYear();
                date = year + "/" + month + "/" + day;
                Object.birthday = date;
            }else{
                Object.birthday = null;
            }
            
            Object.gender = result.rows[i].gender;
            Object.height = result.rows[i].height;
            Object.weight = result.rows[i].weight;
            Object.email = result.rows[i].email;
            Object.phone = result.rows[i].phone;
            Object.campus = result.rows[i].campus;
            Object.password = result.rows[i].password;
            Object.profileimage = result.rows[i].profileimage;
            JSON2Send.push(Object);
        }
        res.end(JSON.stringify(JSON2Send));
    }
}

app.post('/deleteUserInfo',function(req,res){
         var sql = "DELETE FROM users WHERE email = $1 and password = $2;";
         Database.query(sql,[req.body.email,req.body.password],deleteUserCB,res,req);
         });

function deleteUserCB(err,result,res,req){
    if(err){
        console.log(err);
        res.send(err);
    }else{
        res.send('ok');
    }
}


app.post('/updateUserPassword',function(req,res){
         var sql = "UPDATE users SET password = $1,hashedpassword = $2 WHERE email = $3 AND password = $4;";
         var hashedpassword = bcrypt.hashSync(req.body.newPassword);
         Database.query(sql,[req.body.newPassword,hashedpassword,req.body.email,req.body.oldPassword],updateUserPasswordCB,res,req);
         });

function updateUserPasswordCB(err,result,res,req){
    if(err){
        console.log(err);
        res.send(err);
    }else{
        res.send('ok');
    }
}

app.get('/getAllEventsInfo',function(req,res){
        //natural join users and event tables
        var sql = "SELECT first_name||' '||last_name AS ownername,eventid,name,location,numppl,attendance,datetime,endtime,eventtype FROM users u JOIN event e ON u.id = e.eventadminid;";
        Database.query(sql,[],GetAllEventsCB,res,req);
        });

function GetAllEventsCB(err,result,res,req){
    var JSON2Send = [];
    //console.log(result);
    if(err){
        console.log(err);
        res.send(err);
    }
    else if(result.rowCount == 0){
        //no users in the table
        res.end(JSON.stringify(JSON2Send));
    }else{
        //at least one user in the table
        var len = result.rowCount;
        for(var i = 0;i < len;i++){
            var Object = {};
            Object.ownername = result.rows[i].ownername;
            Object.name = result.rows[i].name;
            Object.location = result.rows[i].location;
            Object.numppl = result.rows[i].numppl;
            Object.attendance = result.rows[i].attendance;
            
            //convert date to year/month/day format
            var date = '';
            var month = result.rows[i].datetime.getUTCMonth() + 1;
            var day = result.rows[i].datetime.getUTCDate();
            var year = result.rows[i].datetime.getUTCFullYear();
            var hour = result.rows[i].datetime.getHours();
            var minute = result.rows[i].datetime.getMinutes();
            date = year + "-" + month + "-" + day + '  ' +formatAMPM(result.rows[i].datetime);
            Object.datetime = date;
            
            Object.endtime = result.rows[i].endtime;
            Object.eventtype = result.rows[i].eventtype;
            //store eventid for delete api
            Object.eventid = result.rows[i].eventid;
            //console.log(Object.eventid);
            JSON2Send.push(Object);
        }
        //console.log(JSON2Send);
        res.end(JSON.stringify(JSON2Send));
    }
}

function formatAMPM(date)
{
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0'+minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return strTime;
}

app.post('/deleteEventInfo',function(req,res){
         var sql = 'DELETE FROM event WHERE eventid = $1;';
         Database.query(sql,[req.body.eventid],DeleteEventCB,res,req);
         });

function DeleteEventCB(err,result,res,req){
    if(err){
        console.log(err);
        res.send(err);
    }else{
        res.send('ok');
    }
}

app.get('/getStatusInfo',function(req,res){
        var sql = 'SELECT * FROM users;';
        Database.query(sql,[],getStatusInfoCB,res,req);
        });


var JSON2Send = {};
function getStatusInfoCB(err,result,res,req){
    if(err){
        JSON2Send.stats = err;
    }else{
        JSON2Send.totalUsers = result.rowCount;
        var sql = 'SELECT * FROM event;';
        Database.query(sql,[],getEventCB,res,req);
    }
}
function getEventCB(err,result,res,req){
    if(err){
        JSON2Send.stats = err;
    }else{
        JSON2Send.stats = 'ok';
        JSON2Send.totalEvents = result.rowCount;
        if(result.rowCount > 0){
            //arr for storing # of sports
            var count = [0,0,0,0,0,0,0,0,0,0,0,0,0];
            for(var i = 0;i < result.rowCount;i++){
                count[parseInt(result.rows[i].eventtypeid)]++;
            }
            var largest = Math.max.apply(Math, count);
            //sportids for storing the max sportid
            var sportids = [];
            for(var i = 0;i < count.length;i++){
                if(count[i] == largest){
                    sportids.push(i);
                }
            }
            JSON2Send.popularSport = " ";
            var arrSports = ['cycling','waterpolo','squash','boxing','taekwondo',
                             'basketball','tabletennis','tennis','volleyball','football','swimming'];
            for(var i = 0;i < sportids.length;i++){
                if(i < sportids.length - 1){
                    JSON2Send.popularSport += arrSports[sportids[i]-1] + "<br>";
                }
                else{
                    JSON2Send.popularSport += arrSports[sportids[i]-1];
                }
            }
            
        }else{
            JSON2Send.popularSport = '';
        }
        res.end(JSON.stringify(JSON2Send));
    }
}

app.get('/AdminSignOut', function(req,res)
        {
        //clear all the cookies
        res.clearCookie('AdminName');
        //AJAX will go to the homepage
        res.send("Signed Out");
        });

/*****************************************End Admin Jim*****************************************************************/

/***********************Paul START***********************/

//export app to use in unit test.
module.exports = app;


app.get("/deleteUser", function(req, res) {
        var sql = "DELETE FROM Users WHERE email = 'tester@tsports.com';";
        Database.query(sql, [], GenericCB, res, req );
        res.send("DELETED");
        });



/***********************Paul END**************************/








/*************************************************************************************************************/

//Sign out
app.get('/SignOut', function(req,res)
{
        //clear all the cookies
        res.clearCookie('UserID');
        res.clearCookie('UserEmail');
        res.clearCookie('UserPass');
        res.clearCookie('FriendIDClicked');
        res.clearCookie('EventIDOpened');
        
        //AJAX will go to the homepage
        res.send("Signed Out");
});


//This callback function does nothing
//Only used for modifying/inserting in the DB
//Used as a placeholder
function GenericCB(err, result,res, req)
{
    if (err)
    {
        console.error(err);
        //res.send("Error " + err);
    }
    else
    {
       //Success
       //Do nothing
        
    }
    
}





















